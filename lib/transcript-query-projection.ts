import { createHash } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";
import type { PoolClient } from "pg";
import { db } from "./db";
import { monitorSessionAlias, visibleText } from "./monitor-tools";
import type { MonitorSnapshot } from "./types";
import type { SqlProjection } from "./transcript-query-runtime";

const MAX_OBSERVATIONS = 20_000;
const MAX_CHANGED_MESSAGES = 20_000;
const MAX_EXPORT_BYTES = 8 * 1024 * 1024;

export function committedObservationRef(
  snapshot: MonitorSnapshot,
  sessionId: string,
  version: number,
) {
  const hash = createHash("sha256")
    .update(`${snapshot.snapshotId}:${sessionId}:${version}`)
    .digest("hex");
  return `o_${hash.slice(0, 24)}`;
}

function manifest(snapshot: MonitorSnapshot) {
  if (!snapshot.evidenceManifest?.length)
    throw new Error("Committed evidence manifest is unavailable.");
  return snapshot.evidenceManifest;
}

async function inReadTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const value = await work(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function scope(snapshot: MonitorSnapshot) {
  return JSON.stringify(
    manifest(snapshot).map((entry) => ({
      session_id: entry.sessionId,
      ceiling: entry.version,
      reasoning_visible: entry.reasoningVisible,
    })),
  );
}

type Preflight = {
  sessions: string;
  observations: string;
  changedMessages: string;
  bytes: string;
  revoked: boolean;
  unmaterialized: boolean;
  targetReasoning: boolean | null;
};

async function preflight(client: PoolClient, snapshot: MonitorSnapshot, checkSize: boolean) {
  const entries = manifest(snapshot);
  const {
    rows: [policy],
  } = await client.query<Preflight>(
    `SELECT count(DISTINCT CASE WHEN g.id IS NOT NULL THEN s.id END)::text AS sessions,
       count(o.version)::text AS observations,
       coalesce(sum(jsonb_array_length(o.changed_messages)),0)::text AS "changedMessages",
       coalesce(sum(octet_length(o.changed_messages::text)),0)::text AS bytes,
       coalesce(bool_or(m.reasoning_visible AND NOT g.monitor_reasoning),false) AS revoked,
       coalesce(bool_or(o.search_public IS NULL OR o.search_with_reasoning IS NULL),false)
         AS unmaterialized,
       (SELECT monitor_reasoning FROM ctf.games WHERE id=$3 AND owner_id=$1)
         AS "targetReasoning"
     FROM jsonb_to_recordset($2::jsonb) AS m(session_id uuid,ceiling bigint,reasoning_visible boolean)
     LEFT JOIN ctf.agent_sessions s ON s.id=m.session_id
     LEFT JOIN ctf.games g ON g.id=s.game_id AND g.owner_id=$1
     LEFT JOIN ctf.transcript_observations o ON o.session_id=s.id AND o.version<=m.ceiling`,
    [snapshot.userId, scope(snapshot), snapshot.gameId],
  );
  const expected = entries.reduce((sum, entry) => sum + entry.version, 0);
  const target = entries.find((entry) => entry.sessionId === snapshot.targetSessionId);
  if (
    !policy ||
    Number(policy.sessions) !== entries.length ||
    Number(policy.observations) !== expected ||
    policy.revoked ||
    policy.targetReasoning === null ||
    (target?.reasoningVisible && !policy.targetReasoning)
  )
    throw new Error("Evidence capture is no longer available under current permissions.");
  if (policy.unmaterialized) throw new Error("Committed evidence search text is unavailable.");
  if (
    checkSize &&
    (expected > MAX_OBSERVATIONS ||
      Number(policy.changedMessages) > MAX_CHANGED_MESSAGES ||
      Number(policy.bytes) + expected * 220 + entries.length * 160 > MAX_EXPORT_BYTES)
  )
    throw new Error("Committed evidence exceeds the query export limit.");
  return { observationCount: expected, changedMessageCount: Number(policy.changedMessages) };
}

export async function assertTranscriptQueryAccess(snapshot: MonitorSnapshot) {
  await inReadTransaction((client) => preflight(client, snapshot, false));
}

type Delta = {
  sessionId: string;
  version: string;
  observedAt: Date;
  changedStart: number;
  messageCount: number;
  changedMessages: Message[];
  reasoningVisible: boolean;
  currentReasoningVisible: boolean;
};

export async function exportTranscriptQueryProjection(
  snapshot: MonitorSnapshot,
  includeReasoning: boolean,
): Promise<{ projection: SqlProjection; observationCount: number }> {
  const entries = manifest(snapshot);
  const declaredObservations = entries.reduce((sum, entry) => sum + entry.version, 0);
  if (
    entries.length > MAX_OBSERVATIONS ||
    !Number.isSafeInteger(declaredObservations) ||
    declaredObservations > MAX_OBSERVATIONS
  )
    throw new Error("Committed evidence exceeds the query export limit.");
  return inReadTransaction(async (client) => {
    const { observationCount, changedMessageCount } = await preflight(client, snapshot, true);
    const { rows } = await client.query<Delta>(
      `SELECT o.session_id AS "sessionId",o.version::text,o.observed_at AS "observedAt",
         o.changed_start AS "changedStart",o.message_count AS "messageCount",
         o.changed_messages AS "changedMessages",m.reasoning_visible AS "reasoningVisible",
         g.monitor_reasoning AS "currentReasoningVisible"
       FROM jsonb_to_recordset($2::jsonb) AS m(session_id uuid,ceiling bigint,reasoning_visible boolean)
       JOIN ctf.agent_sessions s ON s.id=m.session_id
       JOIN ctf.games g ON g.id=s.game_id AND g.owner_id=$1
       JOIN ctf.transcript_observations o ON o.session_id=s.id AND o.version<=m.ceiling
       ORDER BY o.session_id,o.version`,
      [snapshot.userId, scope(snapshot)],
    );
    if (rows.length !== observationCount)
      throw new Error("Committed evidence disappeared during query export.");
    const sessions: SqlProjection["sessions"] = entries.map((entry) => ({
      session_id: monitorSessionAlias(snapshot, entry.sessionId),
      is_target: Number(entry.sessionId === snapshot.targetSessionId),
      latest_observation_ref: committedObservationRef(snapshot, entry.sessionId, entry.version),
    }));
    const observations: SqlProjection["observations"] = [];
    const messages: SqlProjection["messages"] = [];
    const previous = new Map<string, { version: number; count: number }>();
    for (const row of rows) {
      const version = Number(row.version);
      const prior = previous.get(row.sessionId);
      if (
        version !== (prior?.version ?? 0) + 1 ||
        row.changedStart > (prior?.count ?? 0) ||
        row.changedStart + row.changedMessages.length !== row.messageCount
      )
        throw new Error("Corrupt committed transcript observation history.");
      previous.set(row.sessionId, { version, count: row.messageCount });
      const sessionId = monitorSessionAlias(snapshot, row.sessionId);
      const observationRef = committedObservationRef(snapshot, row.sessionId, version);
      observations.push({
        observation_ref: observationRef,
        session_id: sessionId,
        observation_seq: version,
        observed_at: row.observedAt.toISOString(),
        changed_start: row.changedStart,
        message_count: row.messageCount,
      });
      for (const [offset, source] of row.changedMessages.entries()) {
        const rendered = visibleText(
          source,
          includeReasoning && row.reasoningVisible && row.currentReasoningVisible,
        );
        if (!rendered) continue;
        messages.push({
          observation_ref: observationRef,
          session_id: sessionId,
          message_index: row.changedStart + offset,
          role: rendered.role,
          text: rendered.text,
          tool_call_id:
            rendered.toolCallId ?? rendered.toolCalls?.map((call) => call.id).join(",") ?? null,
          tool_name:
            source.role === "toolResult"
              ? source.toolName
              : (rendered.toolCalls?.map((call) => call.name).join(",") ?? null),
          tool_error: rendered.toolError === undefined ? null : Number(rendered.toolError),
        });
      }
    }
    if (rows.reduce((sum, row) => sum + row.changedMessages.length, 0) !== changedMessageCount)
      throw new Error("Committed evidence changed during query export.");
    const projection = { sessions, observations, messages };
    if (Buffer.byteLength(JSON.stringify(projection), "utf8") > MAX_EXPORT_BYTES)
      throw new Error("Committed evidence exceeds the rendered query export limit.");
    return { projection, observationCount };
  });
}
