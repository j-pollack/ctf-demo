import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { db } from "./db";
import type { MonitorSnapshot } from "./types";
import { reconstructTranscript } from "./transcript-evidence";

const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
export const MAX_HISTORICAL_SESSIONS = 100;
const SIZE_MARGIN_BYTES = 4096;

export class SnapshotTooLargeError extends Error {
  constructor() {
    super("The current session transcript is too large to review safely.");
    this.name = "SnapshotTooLargeError";
  }
}

async function inRepeatableRead<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const value = await fn(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function snapshotSerializedBytes(snapshot: MonitorSnapshot) {
  return Buffer.byteLength(JSON.stringify(snapshot), "utf8");
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
}

type Candidate = {
  id: string;
  bytes: string;
  updatedAt: Date;
  createdAt: Date;
};

async function loadSessions(client: PoolClient, ids: string[]) {
  const { rows: sessions } = await client.query<MonitorSnapshot["sessions"][number]>(
    `SELECT s.id,s.ordinal,s.agent_model AS "agentModel",s.agent_effort AS "agentEffort",
       s.turns,s.messages,coalesce(s.lease_until>now(),false) AS busy,s.system_prompt AS "systemPrompt",
       g.monitor_reasoning AS "reasoningVisible"
     FROM ctf.agent_sessions s JOIN ctf.games g ON g.id=s.game_id WHERE s.id=ANY($1::uuid[])`,
    [ids],
  );
  const { rows: commands } = await client.query<MonitorSnapshot["commands"][number]>(
    `SELECT r.id AS "reviewId",r.session_id AS "sessionId",r.tool_call_id AS "toolCallId",
       r.command,r.admitted_revision::text AS "admittedRevision",
       r.completed_revision::text AS "completedRevision",
       CASE WHEN r.outcome IN ('completed','interrupted','unknown') THEN r.outcome ELSE NULL END AS outcome
     FROM ctf.agent_sessions s JOIN ctf.monitor_reviews r
       ON r.game_id=s.game_id AND r.session_id=s.id
     WHERE s.id=ANY($1::uuid[]) AND r.target_kind='command'
       AND r.command IS NOT NULL ORDER BY r.created_at,r.id`,
    [ids],
  );
  return {
    sessions,
    commands: commands.map((command) => ({
      ...command,
      admittedRevision: command.admittedRevision === null ? null : Number(command.admittedRevision),
      completedRevision:
        command.completedRevision === null ? null : Number(command.completedRevision),
    })),
  };
}

export async function captureMonitorSnapshot(
  gameId: string,
  currentSessionId = gameId,
): Promise<MonitorSnapshot> {
  return inRepeatableRead(async (client) => {
    const {
      rows: [target],
    } = await client.query<{
      userId: string;
      revision: string;
      bytes: string;
      updatedAt: Date;
      createdAt: Date;
    }>(
      `SELECT g.owner_id AS "userId",g.observation_revision::text AS revision,
         (octet_length(s.messages::text) + octet_length(s.system_prompt) + coalesce((
           SELECT sum(octet_length(jsonb_build_object('id',r.id,'toolCallId',r.tool_call_id,
             'command',r.command,'admittedRevision',r.admitted_revision,
             'completedRevision',r.completed_revision,'outcome',r.outcome)::text))
           FROM ctf.monitor_reviews r WHERE r.game_id=s.game_id AND r.session_id=s.id
             AND r.target_kind='command' AND r.command IS NOT NULL),0))::text AS bytes,
         s.updated_at AS "updatedAt",s.created_at AS "createdAt"
       FROM ctf.games g JOIN ctf.agent_sessions s ON s.game_id=g.id
       WHERE g.id=$1 AND s.id=$2`,
      [gameId, currentSessionId],
    );
    if (!target) throw new Error("Review session not found in target run.");
    if (Number(target.bytes) > MAX_SNAPSHOT_BYTES) throw new SnapshotTooLargeError();

    const { sessions: targetSessions, commands: targetCommands } = await loadSessions(client, [
      currentSessionId,
    ]);
    const current = targetSessions[0];
    if (!current) throw new Error("Review session not found in target run.");
    let snapshot: MonitorSnapshot = {
      snapshotId: randomUUID(),
      gameId,
      userId: target.userId,
      targetSessionId: currentSessionId,
      revision: Number(target.revision),
      omittedSessions: 0,
      sessions: [current],
      commands: targetCommands,
    };
    if (snapshotSerializedBytes(snapshot) > MAX_SNAPSHOT_BYTES) throw new SnapshotTooLargeError();

    const {
      rows: [count],
    } = await client.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM ctf.agent_sessions s
       JOIN ctf.games g ON g.id=s.game_id WHERE g.owner_id=$1`,
      [target.userId],
    );
    snapshot = { ...snapshot, omittedSessions: Number(count.total) - 1 };
    const { rows: candidates } = await client.query<Candidate>(
      `SELECT s.id,s.updated_at AS "updatedAt",s.created_at AS "createdAt",
         (octet_length(s.messages::text) + octet_length(s.system_prompt) + coalesce((
           SELECT sum(octet_length(jsonb_build_object('id',r.id,'toolCallId',r.tool_call_id,
             'command',r.command,'admittedRevision',r.admitted_revision,
             'completedRevision',r.completed_revision,'outcome',r.outcome)::text))
           FROM ctf.monitor_reviews r WHERE r.game_id=s.game_id AND r.session_id=s.id
             AND r.target_kind='command' AND r.command IS NOT NULL),0))::text AS bytes
       FROM ctf.agent_sessions s JOIN ctf.games g ON g.id=s.game_id
       WHERE g.owner_id=$1 AND s.id<>$2
       ORDER BY s.updated_at DESC,s.created_at DESC,s.id DESC
       LIMIT $3`,
      [target.userId, currentSessionId, MAX_HISTORICAL_SESSIONS],
    );
    const selected: string[] = [];
    let estimatedBytes = snapshotSerializedBytes(snapshot);
    for (const candidate of candidates) {
      const nextBytes = estimatedBytes + Number(candidate.bytes) + SIZE_MARGIN_BYTES;
      if (nextBytes > MAX_SNAPSHOT_BYTES) continue;
      selected.push(candidate.id);
      estimatedBytes = nextBytes;
    }
    if (selected.length) {
      const historical = await loadSessions(client, selected);
      const byId = new Map(historical.sessions.map((session) => [session.id, session]));
      snapshot = {
        ...snapshot,
        sessions: [
          ...snapshot.sessions,
          ...selected.flatMap((id) => {
            const session = byId.get(id);
            return session ? [session] : [];
          }),
        ],
        commands: [...snapshot.commands, ...historical.commands],
      };
    }
    while (snapshotSerializedBytes(snapshot) > MAX_SNAPSHOT_BYTES && snapshot.sessions.length > 1) {
      const removed = snapshot.sessions.at(-1)!;
      snapshot = {
        ...snapshot,
        sessions: snapshot.sessions.slice(0, -1),
        commands: snapshot.commands.filter((command) => command.sessionId !== removed.id),
      };
    }
    const metadata = new Map<string, { updatedAt: Date; createdAt: Date }>([
      ...candidates.map((candidate) => [candidate.id, candidate] as const),
      [currentSessionId, target],
    ]);
    snapshot = {
      ...snapshot,
      omittedSessions: Number(count.total) - snapshot.sessions.length,
      sessions: [...snapshot.sessions].sort((a, b) => {
        const first = metadata.get(a.id)!;
        const second = metadata.get(b.id)!;
        return (
          second.updatedAt.getTime() - first.updatedAt.getTime() ||
          second.createdAt.getTime() - first.createdAt.getTime() ||
          b.id.localeCompare(a.id)
        );
      }),
    };
    if (snapshotSerializedBytes(snapshot) > MAX_SNAPSHOT_BYTES) throw new SnapshotTooLargeError();
    return freezeDeep(snapshot);
  });
}

export async function captureCommittedMonitorSnapshot(input: {
  gameId: string;
  sessionId: string;
  epoch: number;
  targetVersion: number;
}): Promise<MonitorSnapshot> {
  const { gameId, sessionId, epoch, targetVersion } = input;
  if (!Number.isSafeInteger(epoch) || !Number.isSafeInteger(targetVersion))
    throw new Error("Invalid evidence target.");
  return inRepeatableRead(async (client) => {
    const { rows: targets } = await client.query<{
      userId: string;
      isolated: boolean;
      revision: string;
      observedEpoch: string;
      observedAt: Date;
    }>(
      `SELECT g.owner_id AS "userId",g.monitor_isolation AS isolated,g.observation_revision::text AS revision,
         o.epoch::text AS "observedEpoch",o.observed_at AS "observedAt"
       FROM ctf.games g JOIN ctf.agent_sessions s ON s.game_id=g.id
         JOIN ctf.transcript_observations o ON o.session_id=s.id AND o.version=$3
       WHERE g.id=$1 AND s.id=$2`,
      [gameId, sessionId, targetVersion],
    );
    const target = targets[0];
    if (!target || Number(target.observedEpoch) !== epoch)
      throw new Error("Evidence target is unavailable.");
    const messages = await reconstructTranscript(client, sessionId, targetVersion);
    const { rows: sessions } = await client.query<MonitorSnapshot["sessions"][number]>(
      `SELECT s.id,s.ordinal,s.agent_model AS "agentModel",s.agent_effort AS "agentEffort",
         s.turns,coalesce(s.lease_until>now(),false) AS busy,s.system_prompt AS "systemPrompt",
         g.monitor_reasoning AS "reasoningVisible"
       FROM ctf.agent_sessions s JOIN ctf.games g ON g.id=s.game_id WHERE s.id=$1`,
      [sessionId],
    );
    const current = sessions[0];
    if (!current) throw new Error("Evidence target session is unavailable.");
    const { rows: manifestRows } = await client.query<{
      sessionId: string;
      version: string;
      reasoningVisible: boolean;
      observedAt: Date;
    }>(
      `SELECT s.id AS "sessionId",head.version::text AS version,
         g.monitor_reasoning AS "reasoningVisible",head.observed_at AS "observedAt"
       FROM ctf.agent_sessions s JOIN ctf.games g ON g.id=s.game_id
         JOIN LATERAL (
           SELECT o.version,o.observed_at FROM ctf.transcript_observations o
           WHERE o.session_id=s.id ORDER BY o.version DESC LIMIT 1
         ) head ON true
       WHERE g.owner_id=$1 AND (NOT $2 OR g.id=$3) ORDER BY s.id`,
      [target.userId, target.isolated, gameId],
    );
    const { commands: legacyCommands } = await loadSessions(client, [sessionId]);
    const { rows: operationTable } = await client.query<{ available: string | null }>(
      "SELECT to_regclass('ctf.sprite_operations')::text AS available",
    );
    const commandIds = new Set(
      messages.flatMap((message) =>
        message.role === "assistant"
          ? message.content.flatMap((part) =>
              part.type === "toolCall" && part.name === "sprite_exec" ? [part.id] : [],
            )
          : [],
      ),
    );
    const operationCommands = operationTable[0]?.available
      ? (
          await client.query<{
            reviewId: string;
            sessionId: string;
            toolCallId: string;
            command: string;
            status: "running" | "completed" | "interrupted" | "unknown";
          }>(
            `SELECT id AS "reviewId",session_id AS "sessionId",tool_call_id AS "toolCallId",
             command,status FROM ctf.sprite_operations
           WHERE game_id=$1 AND session_id=$2 AND kind='command' ORDER BY started_at,id`,
            [gameId, sessionId],
          )
        ).rows
          .filter((row) => commandIds.has(row.toolCallId))
          .map((row) => ({
            reviewId: row.reviewId,
            sessionId: row.sessionId,
            toolCallId: row.toolCallId,
            command: row.command,
            admittedRevision: 0,
            completedRevision: row.status === "running" ? null : 0,
            outcome: row.status === "running" ? null : row.status,
          }))
      : [];
    const commands: MonitorSnapshot["commands"] = [...legacyCommands, ...operationCommands];
    const snapshot: MonitorSnapshot = {
      snapshotId: randomUUID(),
      gameId,
      userId: target.userId,
      targetSessionId: sessionId,
      revision: Number(target.revision),
      omittedSessions: 0,
      searchableHistorySessions: manifestRows.length - 1,
      sessions: [
        {
          ...current,
          turns: messages.filter((message) => message.role === "assistant").length,
          messages,
        },
      ],
      commands,
      evidenceManifest: manifestRows.map((row) => ({
        sessionId: row.sessionId,
        version: row.sessionId === sessionId ? targetVersion : Number(row.version),
        reasoningVisible: row.reasoningVisible,
        observedAt: (row.sessionId === sessionId
          ? target.observedAt
          : row.observedAt
        ).toISOString(),
      })),
    };
    if (snapshotSerializedBytes(snapshot) > MAX_SNAPSHOT_BYTES) throw new SnapshotTooLargeError();
    return freezeDeep(snapshot);
  });
}
