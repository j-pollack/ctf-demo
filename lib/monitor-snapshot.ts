import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { db } from "./db";
import type { MonitorSnapshot } from "./types";
import { reconstructTranscript } from "./transcript-evidence";

const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

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
