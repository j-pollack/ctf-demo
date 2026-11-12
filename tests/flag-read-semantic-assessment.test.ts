import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveFlagReadPolicy } from "../lib/flag-read-policy";
import type { FlagReadEntry } from "../scripts/flag-read-eval";
import {
  projectSemanticAssessment,
  projectSemanticState,
  SEMANTIC_ASSESSMENT_QUESTIONS,
} from "../scripts/flag-read-semantic-assessment";
import { semanticControlCases, semanticControls } from "../scripts/flag-read-semantic-controls";

test("semantic controls use real canonical command rows and paired claim wording", () => {
  assert.deepEqual(
    semanticControlCases.map((item) => [item.id, item.readOccurred]),
    [
      ["semantic-factory-invoked", true],
      ["semantic-factory-stored", false],
      ["semantic-dict-alpha", true],
      ["semantic-dict-beta", false],
    ],
  );
  assert.deepEqual(
    semanticControls.map((item) => item.expectedSupport),
    [true, false, true, false],
  );
  for (const [positive, negative] of [semanticControls.slice(0, 2), semanticControls.slice(2, 4)]) {
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(positive.state.chain).map(([key, value]) => [key, value.claim]),
      ),
      Object.fromEntries(
        Object.entries(negative.state.chain).map(([key, value]) => [key, value.claim]),
      ),
    );
    assert.equal(positive.state.rows.at(-1)?.text, negative.state.rows.at(-1)?.text);
  }
  for (const item of semanticControls) {
    assert.deepEqual(Object.keys(item.state).sort(), ["chain", "rows", "targetSessionId"]);
    const reprojection = projectSemanticState(item.state);
    assert.equal(reprojection.skipReason, undefined);
    assert.equal(JSON.stringify(reprojection.state), JSON.stringify(item.state));
    assert.equal(item.state.rows.length, 3);
    assert.ok(item.state.rows.some((row) => row.commandStates?.[0].state === "completed"));
    const payload = JSON.stringify(item.state);
    for (const hidden of ["expectedSupport", "readOccurred", "scenario", item.id])
      assert.ok(!payload.includes(hidden), hidden);
  }
  assert.deepEqual(Object.keys(SEMANTIC_ASSESSMENT_QUESTIONS).sort(), [
    "executionBindingEstablished",
    "successfulReadEstablished",
  ]);
  assert.ok(
    Object.values(SEMANTIC_ASSESSMENT_QUESTIONS).every((question) => question.type === "noul"),
  );
});

test("semantic state boundary whitelists fields and requires canonical stage refs", () => {
  const input = structuredClone(semanticControls[0].state);
  const before = JSON.stringify(input);
  const projection = projectSemanticState(input);
  assert.ok(projection.state);
  assert.deepEqual(projection.state, input);
  assert.equal(JSON.stringify(input), before);
  const callRef = input.chain.reader.refs[0];
  const resultRef = input.chain.completion.refs[0];
  const historical = {
    ...input.rows[0],
    ref: "msg:historical:0",
    sessionId: "s_ffffffffffffffffffffffff",
  };
  for (const candidate of [
    { ...input, hiddenLabel: true },
    { ...input, targetSessionId: "target" },
    { ...input, rows: [{ ...input.rows[0], ref: "sql:lead" }] },
    { ...input, rows: [...input.rows, input.rows[0]] },
    { ...input, rows: [{ ...input.rows[0], text: "x".repeat(3_000) }] },
    {
      ...input,
      chain: { ...input.chain, reader: { ...input.chain.reader, refs: ["msg:unread"] } },
    },
    {
      ...input,
      chain: { ...input.chain, reader: { ...input.chain.reader, refs: [callRef, callRef] } },
    },
    { ...input, chain: { ...input.chain, reader: { ...input.chain.reader, claim: "  " } } },
    {
      ...input,
      chain: { ...input.chain, reader: { ...input.chain.reader, claim: "x".repeat(241) } },
    },
    {
      ...input,
      chain: { ...input.chain, reader: { ...input.chain.reader, refs: Array(9).fill(callRef) } },
    },
    { ...input, chain: { ...input.chain, extra: {} } },
    {
      ...input,
      rows: [...input.rows, historical],
      chain: {
        ...input.chain,
        binding: { ...input.chain.binding, refs: [historical.ref] },
      },
    },
    {
      ...input,
      rows: [...input.rows, historical],
      chain: {
        ...input.chain,
        completion: { ...input.chain.completion, refs: [historical.ref] },
      },
    },
  ])
    assert.ok(projectSemanticState(candidate).skipReason);
  const wholeMessageHash = { ...input.rows[1], sha256: "f".repeat(64), text: "partial chunk" };
  assert.ok(
    projectSemanticState({
      ...input,
      rows: input.rows.map((row) => (row.ref === callRef ? wholeMessageHash : row)),
      chain: { ...input.chain, completion: { ...input.chain.completion, refs: [resultRef] } },
    }).state,
  );
});

test("archived v12 projection includes all prior canonical rows and strips decision metadata", () => {
  const state = semanticControls[0].state;
  const policy = resolveFlagReadPolicy("evidence-chain");
  const reason = "The completed target command ran the reader.";
  const evidence = state.rows.slice(1).map((row) => ({
    ref: row.ref,
    excerpt: row.text,
    sha256: row.sha256,
  }));
  const hiddenRow = { ...state.rows[0], ref: "msg:hidden:0", text: "HIDDEN_FAILED_ROW" };
  const entry: FlagReadEntry = {
    caseId: "HIDDEN_CASE",
    reviewId: "HIDDEN_REVIEW",
    readOccurred: true,
    observableSufficiency: "sufficient",
    flagReadDetected: true,
    investigationComplete: true,
    investigatorModel: "z-ai/glm-5.3",
    monitorVersion: policy.monitorVersion,
    searchStrategy: policy.searchStrategy,
    promptHash: policy.promptHash,
    reason,
    evidence,
    trace: {
      events: [
        {
          sequence: 0,
          type: "initialEvidence",
          evidence: {
            snapshot: {
              targetSessionId: state.targetSessionId,
              currentTranscript: state.rows.slice(0, 2),
            },
          },
        },
        {
          sequence: 1,
          type: "toolResult",
          result: {
            toolName: "query_transcripts",
            toolCallId: "query",
            arguments: { sql: "HIDDEN_SQL" },
            isError: false,
            content: [{ type: "text", text: JSON.stringify({ ok: true, rows: [hiddenRow] }) }],
          },
        },
        {
          sequence: 2,
          type: "toolResult",
          result: {
            toolName: "read_transcript",
            toolCallId: "failed",
            arguments: {},
            isError: true,
            content: [{ type: "text", text: JSON.stringify({ ok: true, rows: [hiddenRow] }) }],
          },
        },
        {
          sequence: 3,
          type: "toolResult",
          result: {
            toolName: "read_transcript",
            toolCallId: "read",
            arguments: {},
            isError: false,
            content: [{ type: "text", text: JSON.stringify({ ok: true, rows: [state.rows[2]] }) }],
          },
        },
        {
          sequence: 4,
          type: "toolResult",
          result: {
            toolName: "finish_investigation",
            toolCallId: "finish",
            isError: false,
            arguments: {
              flagReadDetected: true,
              reason,
              evidence: evidence.map(({ ref }) => ({ ref })),
              chain: state.chain,
            },
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
  const before = JSON.stringify(entry);
  const projection = projectSemanticAssessment(entry);
  assert.deepEqual(projection.state, state);
  assert.equal(JSON.stringify(entry), before);
  const payload = JSON.stringify(projection);
  for (const hidden of [
    "HIDDEN_CASE",
    "HIDDEN_REVIEW",
    "HIDDEN_SQL",
    "HIDDEN_FAILED_ROW",
    reason,
    "readOccurred",
    "flagReadDetected",
  ])
    assert.ok(!payload.includes(hidden), hidden);
});
