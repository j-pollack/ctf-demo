import { createHash } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { db } from "./db";
import { evidenceMessages, monitorSessionAlias } from "./monitor-tools";
import type { MonitorEvidenceMessage } from "./monitor-tools";
import type { MonitorSnapshot } from "./types";
import { reconstructTranscript } from "./transcript-evidence";

const MAX_QUERY_LENGTH = 256;
const PAGE_SIZE = 8;

function digest(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

function manifest(snapshot: MonitorSnapshot) {
  if (!snapshot.evidenceManifest) throw new Error("Committed evidence is unavailable.");
  return snapshot.evidenceManifest;
}

export async function loadVersion(snapshot: MonitorSnapshot, sessionId: string, version: number) {
  const source = manifest(snapshot).find((entry) => entry.sessionId === sessionId);
  if (!source || version > source.version) throw new Error("Unknown evidence version.");
  const client = await db.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const {
      rows: [permission],
    } = await client.query<{
      ownerId: string;
      reasoningVisible: boolean;
      reviewReasoningVisible: boolean;
    }>(
      `SELECT g.owner_id AS "ownerId",g.monitor_reasoning AS "reasoningVisible",
         target.monitor_reasoning AS "reviewReasoningVisible"
       FROM ctf.agent_sessions s JOIN ctf.games g ON g.id=s.game_id
         JOIN ctf.games target ON target.id=$2 AND target.owner_id=g.owner_id WHERE s.id=$1`,
      [sessionId, snapshot.gameId],
    );
    const capturedReviewReasoning =
      manifest(snapshot).find((item) => item.sessionId === snapshot.targetSessionId)
        ?.reasoningVisible ?? false;
    if (
      !permission ||
      permission.ownerId !== snapshot.userId ||
      (source.reasoningVisible && !permission.reasoningVisible) ||
      (capturedReviewReasoning && !permission.reviewReasoningVisible)
    )
      throw new Error("Evidence capture is no longer available under current permissions.");
    const messages = await reconstructTranscript(client, sessionId, version);
    await client.query("COMMIT");
    return { messages, reasoningVisible: source.reasoningVisible && permission.reasoningVisible };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function observationRef(snapshot: MonitorSnapshot, sessionId: string, version: number) {
  return `o_${digest(`${snapshot.snapshotId}:${sessionId}:${version}`).slice(0, 24)}`;
}

export async function searchCommittedTranscripts(
  snapshot: MonitorSnapshot,
  query: string,
  includeReasoning: boolean,
) {
  if (!query || query.length > MAX_QUERY_LENGTH) throw new Error("Invalid literal search query.");
  const entries = manifest(snapshot);
  const targetReasoning =
    entries.find((entry) => entry.sessionId === snapshot.targetSessionId)?.reasoningVisible ??
    false;
  const canReadReasoning = includeReasoning && targetReasoning;
  const client = await db.connect();
  let rows: {
    sessionId: string;
    version: string;
    index: number;
    observedAt: Date;
    role: "user" | "agent" | "tool";
    text: string;
  }[];
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const scope = JSON.stringify(
      entries.map((entry) => ({
        session_id: entry.sessionId,
        ceiling: entry.version,
        reasoning_visible: entry.reasoningVisible,
      })),
    );
    const {
      rows: [policy],
    } = await client.query<{
      count: string;
      observations: string;
      revoked: boolean;
      unmaterialized: boolean;
      reviewReasoningVisible: boolean | null;
    }>(
      `SELECT count(DISTINCT m.session_id)::text AS count,
         count(o.version)::text AS observations,
         coalesce(bool_or(m.reasoning_visible AND NOT g.monitor_reasoning),false) AS revoked,
         coalesce(bool_or(o.search_public IS NULL OR o.search_with_reasoning IS NULL),false)
           AS unmaterialized,
         (SELECT monitor_reasoning FROM ctf.games WHERE id=$3 AND owner_id=$1)
           AS "reviewReasoningVisible"
       FROM jsonb_to_recordset($2::jsonb) AS m(session_id uuid,ceiling bigint,reasoning_visible boolean)
       LEFT JOIN ctf.agent_sessions s ON s.id=m.session_id
       LEFT JOIN ctf.games g ON g.id=s.game_id AND g.owner_id=$1
       LEFT JOIN ctf.transcript_observations o ON o.session_id=s.id AND o.version<=m.ceiling
       WHERE g.id IS NOT NULL`,
      [snapshot.userId, scope, snapshot.gameId],
    );
    if (
      Number(policy.count) !== entries.length ||
      BigInt(policy.observations) !==
        entries.reduce((total, entry) => total + BigInt(entry.version), 0n) ||
      policy.revoked ||
      policy.reviewReasoningVisible === null ||
      (targetReasoning && !policy.reviewReasoningVisible)
    )
      throw new Error("Evidence capture is no longer available under current permissions.");
    if (policy.unmaterialized) throw new Error("Committed evidence search text is unavailable.");
    const result = await client.query<(typeof rows)[number]>(
      `SELECT o.session_id AS "sessionId",o.version::text,
         (o.changed_start + item.ordinality - 1)::int AS index,
         o.observed_at AS "observedAt",
         CASE WHEN (o.changed_messages -> (item.ordinality - 1)::int)->>'role'='assistant' THEN 'agent'
              WHEN (o.changed_messages -> (item.ordinality - 1)::int)->>'role'='toolResult' THEN 'tool'
              ELSE 'user' END AS role,
         substring(rendered.text from greatest(1,strpos(rendered.text,$3)-100)
           for char_length($3)+200) AS text
       FROM jsonb_to_recordset($2::jsonb) AS m(session_id uuid,ceiling bigint,reasoning_visible boolean)
       JOIN ctf.agent_sessions s ON s.id=m.session_id
       JOIN ctf.games g ON g.id=s.game_id AND g.owner_id=$1
       JOIN ctf.transcript_observations o ON o.session_id=s.id AND o.version<=m.ceiling
       CROSS JOIN LATERAL unnest(o.search_public,o.search_with_reasoning)
         WITH ORDINALITY AS item(public_text,reasoning_text,ordinality)
       CROSS JOIN LATERAL (
         SELECT CASE WHEN $4::boolean AND m.reasoning_visible AND g.monitor_reasoning
           THEN item.reasoning_text ELSE item.public_text END AS text
       ) rendered
       WHERE rendered.text IS NOT NULL AND strpos(rendered.text,$3)>0
       ORDER BY o.observed_at,o.session_id,o.version,item.ordinality
       LIMIT 2001`,
      [snapshot.userId, scope, query, canReadReasoning],
    );
    rows = result.rows;
    if (rows.length > 2000) throw new Error("Search result exceeds the retrieval limit.");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  const matches: (MonitorEvidenceMessage & { version: number; observedAt: string })[] = [];
  for (const row of rows) {
    const at = row.text.indexOf(query);
    if (at < 0) continue;
    const start = Math.max(0, at - 100);
    const text = row.text.slice(start, Math.min(row.text.length, at + query.length + 100));
    matches.push({
      ref: `hit:${snapshot.snapshotId}:${monitorSessionAlias(snapshot, row.sessionId)}:${observationRef(snapshot, row.sessionId, Number(row.version))}:${row.index}`,
      sessionId: monitorSessionAlias(snapshot, row.sessionId),
      version: Number(row.version),
      observedAt: row.observedAt.toISOString(),
      index: row.index,
      role: row.role,
      text,
      sha256: digest(text),
      chunkIndex: 0,
      chunkCount: 1,
    });
  }
  return matches;
}

export async function readCommittedTranscript(
  snapshot: MonitorSnapshot,
  alias: string,
  version: number,
  includeReasoning: boolean,
) {
  const entry = manifest(snapshot).find(
    (item) => monitorSessionAlias(snapshot, item.sessionId) === alias,
  );
  if (!entry || !Number.isSafeInteger(version) || version < 1 || version > entry.version)
    throw new Error("Unknown evidence version.");
  const selected = await loadVersion(snapshot, entry.sessionId, version);
  const targetReasoning =
    manifest(snapshot).find((item) => item.sessionId === snapshot.targetSessionId)
      ?.reasoningVisible ?? false;
  const committedRef = observationRef(snapshot, entry.sessionId, version);
  return evidenceMessages(
    snapshot,
    entry.sessionId,
    selected.messages,
    includeReasoning && targetReasoning && selected.reasoningVisible,
  ).map((row) => ({
    ...row,
    ref: `msg:${snapshot.snapshotId}:${row.sessionId}:${committedRef}:${row.index}${row.chunkCount > 1 ? `#${row.chunkIndex}` : ""}`,
  }));
}

export function createCommittedEvidenceTools(
  snapshot: MonitorSnapshot,
  includeReasoning: boolean,
  onPage: (rows: MonitorEvidenceMessage[]) => void,
  onFailure: (error: unknown) => void,
  otherCalls: () => number = () => 0,
) {
  let calls = 0;
  const run = async <T>(work: () => Promise<T>) => {
    try {
      if (++calls > 8 || calls + otherCalls() > 16) throw new Error("Retrieval limit reached.");
      return await work();
    } catch (error) {
      onFailure(error);
      throw error;
    }
  };
  const cursor = (scope: string, offset: number) =>
    Buffer.from(JSON.stringify({ snapshotId: snapshot.snapshotId, scope, offset })).toString(
      "base64url",
    );
  const offsetFrom = (value: string | undefined, scope: string) => {
    if (value === undefined) return 0;
    if (value.length > 512) throw new Error("Invalid cursor.");
    try {
      const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
      if (
        parsed.snapshotId !== snapshot.snapshotId ||
        parsed.scope !== scope ||
        !Number.isSafeInteger(parsed.offset) ||
        parsed.offset < 0 ||
        cursor(scope, parsed.offset) !== value
      )
        throw new Error("Invalid cursor.");
      return parsed.offset as number;
    } catch {
      throw new Error("Invalid cursor.");
    }
  };
  const page = (rows: MonitorEvidenceMessage[], scope: string, value?: string) => {
    const offset = offsetFrom(value, scope);
    if (offset > rows.length) throw new Error("Invalid cursor.");
    const selected: MonitorEvidenceMessage[] = [];
    let bytes = 2;
    for (const row of rows.slice(offset, offset + PAGE_SIZE)) {
      const rowBytes = Buffer.byteLength(JSON.stringify(row), "utf8") + (selected.length ? 1 : 0);
      if (selected.length && bytes + rowBytes > 14_000) break;
      if (!selected.length && bytes + rowBytes > 14_000)
        throw new Error("Evidence item exceeds the page limit.");
      selected.push(row);
      bytes += rowBytes;
    }
    onPage(selected);
    const next = offset + selected.length;
    return {
      rows: selected,
      remaining: rows.length - next,
      ...(next < rows.length ? { nextCursor: cursor(scope, next) } : {}),
    };
  };
  const output = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    details: {},
  });
  const searchTranscriptsParameters = Type.Object(
    {
      query: Type.String({ minLength: 1, maxLength: MAX_QUERY_LENGTH }),
      cursor: Type.Optional(Type.String({ maxLength: 512 })),
    },
    { additionalProperties: false },
  );
  const searchTranscriptsTool: AgentTool<typeof searchTranscriptsParameters> = {
    name: "search_transcripts",
    label: "Search owner transcripts",
    description:
      "Case-sensitive literal search of committed monitor-visible owner evidence. Paths are leads, not filesystem identity. Use opaque cursors only.",
    parameters: searchTranscriptsParameters,
    executionMode: "sequential",
    execute: async (_id, args) =>
      run(async () => {
        const found = await searchCommittedTranscripts(snapshot, args.query, includeReasoning);
        const result = page(found, `search:${digest(args.query)}`, args.cursor);
        return output({
          ...result,
          rows: result.rows.map((row) => {
            const hit = row as (typeof found)[number];
            const entry = manifest(snapshot).find(
              (item) => monitorSessionAlias(snapshot, item.sessionId) === hit.sessionId,
            )!;
            const { version: _version, ...publicHit } = hit;
            return {
              ...publicHit,
              observationRef: observationRef(snapshot, entry.sessionId, hit.version),
              latestObservationRef: observationRef(snapshot, entry.sessionId, entry.version),
              latestObservedAt: entry.observedAt,
            };
          }),
        });
      }),
  };
  const readEvidenceParameters = Type.Object(
    {
      sessionId: Type.String({ minLength: 1, maxLength: 128 }),
      observationRef: Type.String({ minLength: 1, maxLength: 64 }),
      cursor: Type.Optional(Type.String({ maxLength: 512 })),
    },
    { additionalProperties: false },
  );
  const readEvidenceTool: AgentTool<typeof readEvidenceParameters> = {
    name: "read_evidence",
    label: "Read exact transcript version",
    description:
      "Read one immutable version from the committed owner manifest. Source and current visibility policy apply.",
    parameters: readEvidenceParameters,
    executionMode: "sequential",
    execute: async (_id, args) =>
      run(async () => {
        const entry = manifest(snapshot).find(
          (item) => monitorSessionAlias(snapshot, item.sessionId) === args.sessionId,
        );
        if (!entry) throw new Error("Unknown evidence session.");
        const version = Array.from({ length: entry.version }, (_, offset) => offset + 1).find(
          (candidate) =>
            observationRef(snapshot, entry.sessionId, candidate) === args.observationRef,
        );
        if (!version) throw new Error("Unknown evidence version.");
        return output(
          page(
            await readCommittedTranscript(snapshot, args.sessionId, version, includeReasoning),
            `read:${args.sessionId}:${args.observationRef}`,
            args.cursor,
          ),
        );
      }),
  };
  const piTools = [searchTranscriptsTool, readEvidenceTool];
  return {
    piTools,
    get retrievalCalls() {
      return calls;
    },
  };
}
