import { createHash } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import {
  evidenceMessages,
  monitorSessionAlias,
  type MonitorEvidenceMessage,
} from "./monitor-tools";
import { loadVersion } from "./transcript-search";
import {
  assertTranscriptQueryAccess,
  committedObservationRef,
  exportTranscriptQueryProjection,
} from "./transcript-query-projection";
import { runTranscriptSql, type SqlResult } from "./transcript-query-runtime";
import type { MonitorSnapshot } from "./types";

const MAX_CALLS = 16;
const PAGE_ROWS = 50;
const PAGE_BYTES = 12 * 1024;
const INITIAL_BYTES = 8 * 1024;

export type TranscriptInvestigationInitialEvidence = {
  targetSessionId: string;
  targetObservationRef: string;
  schema: string;
  currentTranscript: MonitorEvidenceMessage[];
  scope: { sessionCount: number; observationCount: number; frozen: true };
};

export type TranscriptInvestigationOptions = {
  includeReasoning: boolean;
  signal: AbortSignal;
  onPage: (rows: MonitorEvidenceMessage[]) => void;
  onFatal: (error: unknown) => void;
};

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalMessages(
  snapshot: MonitorSnapshot,
  sessionId: string,
  version: number,
  messages: Awaited<ReturnType<typeof loadVersion>>["messages"],
  includeReasoning: boolean,
) {
  const safeSnapshot = { ...snapshot, commands: [] } satisfies MonitorSnapshot;
  const observationRef = committedObservationRef(snapshot, sessionId, version);
  return evidenceMessages(safeSnapshot, sessionId, messages, includeReasoning).map((row) => {
    const { commandStates: _commandStates, ...visible } = row;
    return {
      ...visible,
      ref: `msg:${snapshot.snapshotId}:${row.sessionId}:${observationRef}:${row.index}${row.chunkCount > 1 ? `#${row.chunkIndex}` : ""}`,
    };
  });
}

function initialExcerpt(rows: MonitorEvidenceMessage[]) {
  const chosen: MonitorEvidenceMessage[] = [];
  let bytes = 2;
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index];
    const size = Buffer.byteLength(JSON.stringify(row), "utf8") + 1;
    if (bytes + size > INITIAL_BYTES) break;
    chosen.unshift(row);
    bytes += size;
  }
  return chosen;
}

function output(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} };
}

export async function createTranscriptInvestigationTools(
  snapshot: MonitorSnapshot,
  currentSessionId: string,
  options: TranscriptInvestigationOptions,
): Promise<{
  piTools: ToolDefinition[];
  initialEvidence: TranscriptInvestigationInitialEvidence;
  readonly retrievalCalls: number;
  dispose: () => Promise<void>;
}> {
  if (currentSessionId !== snapshot.targetSessionId)
    throw new Error("Investigation target does not match the committed snapshot.");
  const entries = snapshot.evidenceManifest;
  const target = entries?.find((entry) => entry.sessionId === currentSessionId);
  if (!entries || !target) throw new Error("Investigation target has no committed evidence.");
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  let calls = 0;
  const fail = (error: unknown): never => {
    options.onFatal(error);
    throw error;
  };
  let projection: Awaited<ReturnType<typeof exportTranscriptQueryProjection>>;
  let targetRows: MonitorEvidenceMessage[];
  try {
    projection = await exportTranscriptQueryProjection(
      snapshot,
      options.includeReasoning && target.reasoningVisible,
    );
    const health = await runTranscriptSql(projection.projection, "SELECT 1 AS ready", signal);
    if (!health.ok || health.rows[0]?.ready !== 1)
      throw new Error(
        health.ok
          ? "SQLite query runtime is unavailable."
          : `SQLite query runtime is unavailable: ${health.error}`,
      );
    const selected = await loadVersion(snapshot, currentSessionId, target.version);
    targetRows = canonicalMessages(
      snapshot,
      currentSessionId,
      target.version,
      selected.messages,
      options.includeReasoning && target.reasoningVisible && selected.reasoningVisible,
    );
  } catch (error) {
    return fail(error);
  }
  const observationRefs = new Map(
    projection.projection.observations.map((row) => [
      row.observation_ref as string,
      { sessionId: row.session_id as string, version: row.observation_seq as number },
    ]),
  );
  const aliases = new Map(
    entries.map((entry) => [monitorSessionAlias(snapshot, entry.sessionId), entry]),
  );
  const schema = `Frozen committed owner evidence. All identifiers are opaque per-review aliases. SQL rows are search leads, never citation evidence. Read exact transcript pages to cite. Relations: sessions(session_id,is_target,latest_observation_ref); observations(observation_ref,session_id,observation_seq,observed_at,changed_start,message_count); messages(observation_ref,session_id,message_index,role,text,tool_call_id,tool_name,tool_error). messages contains changed-message deltas, not a flat latest transcript. observed_at is server ingestion time, not file effect time. Example latest delta only: SELECT s.session_id,m.text FROM sessions s JOIN messages m ON m.observation_ref=s.latest_observation_ref WHERE m.text LIKE '%flag%'. Use read_transcript without observationRef to reconstruct the complete latest transcript. Example repair: SELECT o.session_id,o.observation_seq,o.changed_start,o.message_count,m.message_index,m.text FROM observations o JOIN messages m ON m.observation_ref=o.observation_ref WHERE o.session_id=(SELECT session_id FROM sessions WHERE is_target=1) ORDER BY o.observation_seq,m.message_index. A later changed_start replaces or removes the prior suffix.`;
  const initialEvidence: TranscriptInvestigationInitialEvidence = {
    targetSessionId: monitorSessionAlias(snapshot, currentSessionId),
    targetObservationRef: committedObservationRef(snapshot, currentSessionId, target.version),
    schema,
    currentTranscript: initialExcerpt(targetRows),
    scope: {
      sessionCount: entries.length,
      observationCount: projection.observationCount,
      frozen: true,
    },
  };

  const cursor = (kind: string, key: string, offset: number) =>
    Buffer.from(JSON.stringify({ snapshotId: snapshot.snapshotId, kind, key, offset })).toString(
      "base64url",
    );
  const parseCursor = (value: string | undefined, kind: string, key: string, length: number) => {
    if (value === undefined) return 0;
    if (value.length > 512) throw new Error("Invalid cursor.");
    try {
      const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
      if (
        parsed.snapshotId !== snapshot.snapshotId ||
        parsed.kind !== kind ||
        parsed.key !== key ||
        !Number.isSafeInteger(parsed.offset) ||
        parsed.offset < 0 ||
        parsed.offset > length ||
        cursor(kind, key, parsed.offset) !== value
      )
        throw new Error("Invalid cursor.");
      return parsed.offset as number;
    } catch {
      throw new Error("Invalid cursor.");
    }
  };
  const page = <T>(rows: T[], offset: number) => {
    const chosen: T[] = [];
    let bytes = 2;
    for (const row of rows.slice(offset, offset + PAGE_ROWS)) {
      const size = Buffer.byteLength(JSON.stringify(row), "utf8") + 1;
      if (bytes + size > PAGE_BYTES) {
        if (!chosen.length)
          throw new Error(
            "A result row exceeds the page limit; select narrower columns or substrings.",
          );
        break;
      }
      chosen.push(row);
      bytes += size;
    }
    return { rows: chosen, nextOffset: offset + chosen.length };
  };
  const run = async (work: () => Promise<unknown>) => {
    try {
      if (++calls > MAX_CALLS) throw new Error("Transcript retrieval limit reached.");
      if (signal.aborted) throw new Error("Transcript investigation was cancelled.");
      await assertTranscriptQueryAccess(snapshot);
      const result = await work();
      if (signal.aborted) throw new Error("Transcript investigation was cancelled.");
      await assertTranscriptQueryAccess(snapshot);
      return output(result);
    } catch (error) {
      return fail(error);
    }
  };
  const recover = (error: unknown) => ({
    ok: false,
    error: error instanceof Error ? error.message : "Invalid request.",
  });
  const resultCache = new Map<string, Extract<SqlResult, { ok: true }>>();
  const queryParameters = Type.Object(
    {
      sql: Type.String({ minLength: 1, maxLength: 8192 }),
      cursor: Type.Optional(Type.String({ maxLength: 512 })),
    },
    { additionalProperties: false },
  );
  const readParameters = Type.Object(
    {
      sessionId: Type.String({ minLength: 1, maxLength: 128 }),
      observationRef: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
      cursor: Type.Optional(Type.String({ maxLength: 512 })),
    },
    { additionalProperties: false },
  );
  const piTools: ToolDefinition[] = [
    defineTool({
      name: "query_transcripts",
      label: "Query frozen transcripts",
      description:
        "Run bounded read-only SQLite over frozen owner transcript deltas. SQL rows are leads, not citations. Use read_transcript for exact evidence.",
      parameters: queryParameters,
      executionMode: "sequential",
      execute: async (_id, args) => {
        const valid = Value.Check(queryParameters, args);
        return run(async () => {
          if (!valid) return recover(new Error("Invalid query_transcripts arguments."));
          const key = digest(args.sql);
          let result = resultCache.get(key);
          if (!result && args.cursor) return recover(new Error("Invalid cursor."));
          if (!result) {
            const queried = await runTranscriptSql(projection.projection, args.sql, signal);
            if (!queried.ok) return queried;
            result = queried;
            resultCache.set(key, result);
          }
          try {
            const offset = parseCursor(args.cursor, "query", key, result.rows.length);
            const selected = page(result.rows, offset);
            return {
              ok: true,
              rows: selected.rows,
              citationEligible: false,
              remaining: result.rows.length - selected.nextOffset,
              truncated: result.truncated,
              ...(selected.nextOffset < result.rows.length
                ? { nextCursor: cursor("query", key, selected.nextOffset) }
                : {}),
            };
          } catch (error) {
            return recover(error);
          }
        });
      },
    }),
    defineTool({
      name: "read_transcript",
      label: "Read exact committed transcript",
      description:
        "Read an exact immutable committed version with stable citation refs. Defaults to the latest allowed observation for that session.",
      parameters: readParameters,
      executionMode: "sequential",
      execute: async (_id, args) => {
        const valid = Value.Check(readParameters, args);
        return run(async () => {
          if (!valid) return recover(new Error("Invalid read_transcript arguments."));
          const entry = aliases.get(args.sessionId);
          if (!entry) return recover(new Error("Unknown evidence session."));
          const selected = args.observationRef
            ? observationRefs.get(args.observationRef)
            : { sessionId: args.sessionId, version: entry.version };
          if (
            !selected ||
            selected.sessionId !== args.sessionId ||
            selected.version > entry.version
          )
            return recover(new Error("Unknown evidence observation."));
          const ref = committedObservationRef(snapshot, entry.sessionId, selected.version);
          const key = `${args.sessionId}:${ref}`;
          let offset: number;
          try {
            offset = parseCursor(args.cursor, "read", key, Number.MAX_SAFE_INTEGER);
          } catch (error) {
            return recover(error);
          }
          const source = await loadVersion(snapshot, entry.sessionId, selected.version);
          const rows = canonicalMessages(
            snapshot,
            entry.sessionId,
            selected.version,
            source.messages,
            options.includeReasoning &&
              target.reasoningVisible &&
              entry.reasoningVisible &&
              source.reasoningVisible,
          );
          if (offset > rows.length) return recover(new Error("Invalid cursor."));
          let chosen: ReturnType<typeof page<MonitorEvidenceMessage>>;
          try {
            chosen = page(rows, offset);
          } catch (error) {
            return recover(error);
          }
          if (signal.aborted) throw new Error("Transcript investigation was cancelled.");
          await assertTranscriptQueryAccess(snapshot);
          options.onPage(chosen.rows);
          return {
            ok: true,
            rows: chosen.rows,
            observationRef: ref,
            remaining: rows.length - chosen.nextOffset,
            ...(chosen.nextOffset < rows.length
              ? { nextCursor: cursor("read", key, chosen.nextOffset) }
              : {}),
          };
        });
      },
    }),
  ];
  return {
    piTools,
    initialEvidence,
    get retrievalCalls() {
      return calls;
    },
    dispose: async () => {
      controller.abort();
      resultCache.clear();
    },
  };
}
