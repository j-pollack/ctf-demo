import assert from "node:assert/strict";
import { test } from "node:test";
import { projectShadowState } from "../scripts/flag-read-shadow";
import type { FlagReadEntry } from "../scripts/flag-read-eval";

const target = "s_0123456789abcdef01234567";
const row = {
  ref: "msg:opaque:s_0123456789abcdef01234567:0",
  sessionId: target,
  role: "tool",
  text: "read-ok\n[exit 0]",
  sha256: "a".repeat(64),
  index: 0,
  chunkIndex: 0,
  chunkCount: 1,
  toolCallId: "exec-1",
  toolError: false,
  toolCalls: [{ id: "call-1", name: "sprite_exec" }],
  commandStates: [{ toolCallId: "exec-1", state: "completed" }],
  hidden: "HIDDEN_ROW",
};
const entry: FlagReadEntry = {
  caseId: "HIDDEN_CASE_ID",
  reviewId: "HIDDEN_REVIEW_ID",
  readOccurred: true,
  observableSufficiency: "sufficient",
  flagReadDetected: true,
  investigationComplete: true,
  investigatorModel: "z-ai/glm-5.3",
  monitorVersion: "investigator-v6-glm53-jev114-canonical-refs",
  reason: "The tool reported a successful read.",
  evidence: [{ ref: row.ref, excerpt: row.text, sha256: row.sha256 }],
  trace: {
    events: [
      {
        sequence: 0,
        type: "initialEvidence",
        evidence: {
          snapshot: { targetSessionId: target, currentTranscript: [row], hidden: "HIDDEN_INITIAL" },
        },
      },
      {
        sequence: 1,
        type: "toolResult",
        result: {
          toolName: "query_transcripts",
          toolCallId: "raw-query",
          arguments: { sql: "HIDDEN_SQL" },
          isError: false,
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: true, rows: [{ text: "HIDDEN_QUERY_ROW" }] }),
            },
          ],
        },
      },
      {
        sequence: 2,
        type: "toolResult",
        result: {
          toolName: "read_transcript",
          toolCallId: "raw-read",
          arguments: { sessionId: target },
          isError: false,
          content: [{ type: "text", text: JSON.stringify({ ok: true, rows: [row] }) }],
        },
      },
      {
        sequence: 3,
        type: "toolResult",
        result: {
          toolName: "finish_investigation",
          toolCallId: "raw-finish",
          arguments: {},
          isError: false,
          content: [],
        },
      },
    ],
    omittedEvents: 0,
    omittedBytes: 0,
    recordingErrors: 0,
    recordingErrorCodes: [],
  },
  latencyMs: 10,
  settledMicrodollars: 2,
  heldMicrodollars: 0,
};

test("shadow projects accepted decision and canonical evidence only", () => {
  const projection = projectShadowState(entry);
  assert.deepEqual(projection, {
    state: {
      targetSessionId: target,
      decision: { flagReadDetected: true, reason: entry.reason, evidence: entry.evidence },
      rows: [
        {
          ref: row.ref,
          sessionId: row.sessionId,
          role: row.role,
          text: row.text,
          sha256: row.sha256,
          index: row.index,
          chunkIndex: row.chunkIndex,
          chunkCount: row.chunkCount,
          toolCallId: row.toolCallId,
          toolError: row.toolError,
          toolCalls: row.toolCalls,
          commandStates: row.commandStates,
        },
      ],
    },
  });
  const serialized = JSON.stringify(projection);
  for (const secret of [
    "HIDDEN_CASE_ID",
    "HIDDEN_REVIEW_ID",
    "HIDDEN_INITIAL",
    "HIDDEN_SQL",
    "HIDDEN_QUERY_ROW",
    "HIDDEN_ROW",
    "readOccurred",
    "observableSufficiency",
  ])
    assert.ok(!serialized.includes(secret), secret);
});

test("shadow skips incomplete traces and unverified citations", () => {
  assert.deepEqual(projectShadowState({ ...entry, investigationComplete: null }), {
    skipReason: "unfinished decision",
  });
  assert.deepEqual(projectShadowState({ ...entry, investigatorModel: "unapproved" }), {
    skipReason: "unaccepted investigator version",
  });
  assert.deepEqual(projectShadowState({ ...entry, trace: { ...entry.trace!, omittedEvents: 1 } }), {
    skipReason: "incomplete trace",
  });
  assert.deepEqual(
    projectShadowState({
      ...entry,
      evidence: [{ ref: "unknown", excerpt: row.text, sha256: row.sha256 }],
    }),
    { skipReason: "citation outside visible evidence" },
  );
  const failedQuery = {
    ...entry,
    trace: {
      ...entry.trace!,
      events: entry.trace!.events.map((event) =>
        event.type === "toolResult" && event.result.toolName === "query_transcripts"
          ? {
              ...event,
              result: {
                ...event.result,
                content: [{ type: "text", text: JSON.stringify({ ok: false, error: "bad SQL" }) }],
              },
            }
          : event,
      ),
    },
  } satisfies FlagReadEntry;
  assert.deepEqual(projectShadowState(failedQuery), projectShadowState(entry));
  const readEvent = entry.trace!.events[2];
  if (readEvent.type !== "toolResult") throw new Error("Expected read transcript event.");
  const failedRead = {
    ...entry,
    trace: {
      ...entry.trace!,
      events: [
        ...entry.trace!.events.slice(0, 2),
        {
          ...readEvent,
          result: {
            ...readEvent.result,
            content: [
              {
                type: "text",
                text: JSON.stringify({ ok: false, rows: [{ ...row, text: "HIDDEN_FAILED_ROW" }] }),
              },
            ],
          },
        },
        ...entry.trace!.events.slice(3),
      ],
    },
  } satisfies FlagReadEntry;
  assert.deepEqual(projectShadowState(failedRead), projectShadowState(entry));
});
