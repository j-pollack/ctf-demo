import { isDeepStrictEqual } from "node:util";
import type { Message } from "@earendil-works/pi-ai";
import type { Pool, PoolClient } from "pg";
import { visibleText } from "./monitor-tools";

export type EvidenceWrite = {
  gameId: string;
  sessionId: string;
  runRevision: number;
  messages: readonly Message[];
};

function searchText(messages: readonly Message[]) {
  return {
    publicText: messages.map((message) => visibleText(message, false)?.text ?? null),
    reasoningText: messages.map((message) => visibleText(message, true)?.text ?? null),
  };
}

export async function backfillTranscriptSearchText(client: Pool | PoolClient): Promise<void> {
  while (true) {
    const { rows } = await client.query<{
      sessionId: string;
      version: string;
      bytes: number;
    }>(
      `SELECT session_id AS "sessionId",version::text,
         octet_length(changed_messages::text) AS bytes
       FROM ctf.transcript_observations
       WHERE search_public IS NULL OR search_with_reasoning IS NULL
       ORDER BY session_id,version LIMIT 32`,
    );
    if (!rows.length) return;
    let bytes = 0;
    const batch: typeof rows = [];
    for (const row of rows) {
      if (bytes + row.bytes > 4 * 1024 * 1024) break;
      bytes += row.bytes;
      batch.push(row);
    }
    if (!batch.length)
      throw new Error("Legacy transcript search evidence exceeds the backfill batch limit.");
    for (const row of batch) {
      const {
        rows: [payload],
      } = await client.query<{ changedMessages: Message[] }>(
        `SELECT changed_messages AS "changedMessages" FROM ctf.transcript_observations
         WHERE session_id=$1 AND version=$2`,
        [row.sessionId, row.version],
      );
      if (!payload) throw new Error("Legacy transcript evidence disappeared during backfill.");
      const rendered = searchText(payload.changedMessages);
      await client.query(
        `UPDATE ctf.transcript_observations
         SET search_public=$3,search_with_reasoning=$4
         WHERE session_id=$1 AND version=$2
           AND search_public IS NULL AND search_with_reasoning IS NULL`,
        [row.sessionId, row.version, rendered.publicText, rendered.reasoningText],
      );
    }
  }
}

export function diffTranscript(previous: readonly unknown[], next: readonly unknown[]) {
  let start = 0;
  while (
    start < previous.length &&
    start < next.length &&
    isDeepStrictEqual(previous[start], next[start])
  )
    start++;
  return {
    appendOnly: start === previous.length,
    changed: Array.from({ length: next.length - start }, (_, offset) => start + offset),
  };
}

type Observation = {
  version: string;
  epoch: string;
  messageCount: number;
  changedStart: number;
  changedMessages: Message[];
};

export async function reconstructTranscript(
  client: PoolClient,
  sessionId: string,
  version: number,
): Promise<Message[]> {
  if (!Number.isSafeInteger(version) || version < 1) throw new Error("Invalid evidence version.");
  const {
    rows: [size],
  } = await client.query<{ count: string; bytes: string }>(
    `SELECT count(*)::text AS count,
       coalesce(sum(octet_length(changed_messages::text)),0)::text AS bytes
     FROM ctf.transcript_observations WHERE session_id=$1 AND version<=$2`,
    [sessionId, version],
  );
  if (Number(size.count) !== version) throw new Error("Incomplete evidence history.");
  if (version > 10_000) throw new Error("Transcript evidence exceeds the version limit.");
  if (Number(size.bytes) > 16 * 1024 * 1024)
    throw new Error("Transcript evidence exceeds the reconstruction limit.");
  const { rows } = await client.query<Observation>(
    `SELECT version::text,epoch::text,message_count AS "messageCount",
       changed_start AS "changedStart",changed_messages AS "changedMessages"
     FROM ctf.transcript_observations o WHERE session_id=$1 AND version<=$2 ORDER BY o.version`,
    [sessionId, version],
  );
  if (!rows.length || Number(rows.at(-1)!.version) !== version)
    throw new Error("Evidence version is unavailable.");
  let messages: Message[] = [];
  for (const [index, row] of rows.entries()) {
    if (Number(row.version) !== index + 1) throw new Error("Incomplete evidence history.");
    if (row.changedStart > messages.length) throw new Error("Corrupt evidence history.");
    messages = [...messages.slice(0, row.changedStart), ...row.changedMessages];
    if (messages.length !== row.messageCount) throw new Error("Corrupt evidence history.");
  }
  return messages;
}

export async function persistTranscriptEvidence(client: PoolClient, write: EvidenceWrite) {
  const { gameId, sessionId, runRevision, messages } = write;
  if (
    !Number.isSafeInteger(runRevision) ||
    runRevision < 0 ||
    !Array.isArray(messages) ||
    messages.some((message) => !message || typeof message !== "object")
  )
    throw new Error("Invalid transcript evidence input.");
  const session = await client.query(
    "SELECT id FROM ctf.agent_sessions WHERE game_id=$1 AND id=$2 FOR UPDATE",
    [gameId, sessionId],
  );
  if (!session.rowCount) throw new Error("Evidence session does not belong to run.");
  const { rows: heads } = await client.query<Observation>(
    `SELECT version::text,epoch::text,message_count AS "messageCount",
       changed_start AS "changedStart",changed_messages AS "changedMessages"
     FROM ctf.transcript_observations o WHERE session_id=$1 ORDER BY o.version DESC LIMIT 1`,
    [sessionId],
  );
  const head = heads[0];
  const previous = head ? await reconstructTranscript(client, sessionId, Number(head.version)) : [];
  // Compare stored form with stored form: live messages can hold values jsonb drops (such as
  // undefined fields), which would otherwise look like a rewrite and start a new review epoch.
  const {
    rows: [normalized],
  } = await client.query<{ messages: Message[] }>("SELECT $1::jsonb AS messages", [
    JSON.stringify(messages),
  ]);
  const { appendOnly, changed } = diffTranscript(previous, normalized.messages);
  if (head && previous.length === messages.length && changed.length === 0)
    return {
      version: Number(head.version),
      epoch: Number(head.epoch),
      changed: false,
      appendOnly: true,
    };
  const start = changed[0] ?? messages.length;
  const version = head ? Number(head.version) + 1 : 1;
  const epoch = head ? Number(head.epoch) + (appendOnly ? 0 : 1) : 1;
  const appendedMessages = normalized.messages.slice(start);
  const rendered = searchText(appendedMessages);
  await client.query(
    `INSERT INTO ctf.transcript_observations
       (session_id,version,epoch,run_revision,message_count,changed_start,changed_indices,
        changed_messages,search_public,search_with_reasoning,provenance)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'runtime')`,
    [
      sessionId,
      version,
      epoch,
      runRevision,
      messages.length,
      start,
      changed,
      JSON.stringify(appendedMessages),
      rendered.publicText,
      rendered.reasoningText,
    ],
  );
  return { version, epoch, changed: true, appendOnly };
}
