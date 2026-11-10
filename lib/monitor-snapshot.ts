import type { PoolClient } from "pg";
import { db } from "./db";
import type { MonitorSnapshot } from "./types";

const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

export class SnapshotTooLargeError extends Error {
  constructor() {
    super("The workspace transcript is too large to review safely.");
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

export async function captureMonitorSnapshot(gameId: string): Promise<MonitorSnapshot> {
  return inRepeatableRead(async (client) => {
    const {
      rows: [size],
    } = await client.query<{ bytes: string }>(
      `SELECT coalesce(sum(octet_length(s.messages::text) + octet_length(
          jsonb_build_object('id',s.id,'ordinal',s.ordinal,'agentModel',s.agent_model,'agentEffort',s.agent_effort,
            'turns',s.turns,'busy',coalesce(s.lease_until>now(),false))::text)),0)
        + coalesce((SELECT sum(octet_length(jsonb_build_object('reviewId',r.id,'sessionId',r.session_id,
            'toolCallId',r.tool_call_id,'command',r.command,'admittedRevision',r.admitted_revision,
            'completedRevision',r.completed_revision,'outcome',r.outcome)::text))
          FROM ctf.monitor_reviews r WHERE r.game_id=$1 AND r.target_kind='command' AND r.command IS NOT NULL),0)
        + octet_length(jsonb_build_object('gameId',$1,'revision',
          (SELECT observation_revision FROM ctf.games WHERE id=$1))::text)
        AS bytes FROM ctf.agent_sessions s WHERE s.game_id=$1`,
      [gameId],
    );
    if (Number(size.bytes) > MAX_SNAPSHOT_BYTES) throw new SnapshotTooLargeError();
    const {
      rows: [run],
    } = await client.query<{ observation_revision: string }>(
      "SELECT observation_revision FROM ctf.games WHERE id=$1",
      [gameId],
    );
    if (!run) throw new Error("Workspace not found.");
    const { rows: sessions } = await client.query<MonitorSnapshot["sessions"][number]>(
      `SELECT id,ordinal,agent_model AS "agentModel",agent_effort AS "agentEffort",turns,messages,
        coalesce(lease_until>now(),false) AS busy FROM ctf.agent_sessions WHERE game_id=$1 ORDER BY ordinal`,
      [gameId],
    );
    const { rows: commands } = await client.query<MonitorSnapshot["commands"][number]>(
      `SELECT id AS "reviewId",session_id AS "sessionId",tool_call_id AS "toolCallId",command,
        admitted_revision::text AS "admittedRevision",completed_revision::text AS "completedRevision",
        CASE WHEN outcome IN ('completed','interrupted','unknown') THEN outcome ELSE NULL END AS outcome
      FROM ctf.monitor_reviews WHERE game_id=$1 AND target_kind='command' AND command IS NOT NULL ORDER BY created_at,id`,
      [gameId],
    );
    const snapshot: MonitorSnapshot = {
      gameId,
      revision: Number(run.observation_revision),
      sessions,
      commands: commands.map((command) => ({
        ...command,
        admittedRevision:
          command.admittedRevision === null ? null : Number(command.admittedRevision),
        completedRevision:
          command.completedRevision === null ? null : Number(command.completedRevision),
      })),
    };
    if (snapshotSerializedBytes(snapshot) > MAX_SNAPSHOT_BYTES) throw new SnapshotTooLargeError();
    return freezeDeep(snapshot);
  });
}
