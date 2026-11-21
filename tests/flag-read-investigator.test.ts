import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import {
  READ_CONFIRMATION_REQUEST,
  createFinishInvestigationTool,
  type FlagReadDecision,
  type ReadConfirmation,
} from "../lib/monitor-evidence";
import {
  detectorToReviewDecision,
  type FlagReadInvestigationResult,
} from "../lib/flag-read-investigator";
import { FLAG_READ_MONITOR_VERSION } from "../lib/control";
import { flagReadPolicyById } from "../lib/flag-read-policy";
import { INVESTIGATOR_EFFORT, INVESTIGATOR_MODEL } from "../lib/investigator-driver";
import {
  MONITOR_MESSAGE_CHUNK_JSON_BYTES,
  type MonitorEvidenceMessage,
} from "../lib/monitor-tools";

const target: MonitorEvidenceMessage = {
  ref: "msg:target:observation:2",
  sessionId: "target-session",
  index: 2,
  role: "tool",
  text: "The completed command printed the protected contents.",
  sha256: "target-hash",
  chunkIndex: 0,
  chunkCount: 1,
};
const historical: MonitorEvidenceMessage = {
  ...target,
  ref: "msg:history:observation:4",
  sessionId: "historical-session",
  sha256: "historical-hash",
};

test("flag read finish derives completion and requires target-anchored canonical findings", async () => {
  const visible = new Map([target, historical].map((row) => [row.ref, row]));
  const decisions: FlagReadDecision[] = [];
  const failures: unknown[] = [];
  const invalid: string[] = [];
  const tool = createFinishInvestigationTool(
    visible,
    target.sessionId,
    (decision) => decisions.push(decision),
    (error) => failures.push(error),
    (_error, id) => invalid.push(id),
    () => ({ calls: 1, limit: 1 }),
  );
  const base = { reason: "A successful read is visible in the target tool result." };
  const cite = (row: MonitorEvidenceMessage) => ({ ref: row.ref });
  const execute = (id: string, args: unknown) =>
    tool.execute(id, args as never, undefined, undefined);
  await assert.rejects(
    execute("model-completion", {
      ...base,
      flagReadDetected: true,
      investigationComplete: false,
      evidence: [cite(target)],
    }),
    /arguments/i,
  );
  await assert.rejects(
    execute("history-only", {
      ...base,
      flagReadDetected: true,
      evidence: [cite(historical)],
    }),
    /target|session/i,
  );
  await assert.rejects(
    execute("extra-excerpt", {
      ...base,
      flagReadDetected: true,
      evidence: [{ ref: target.ref, excerpt: "fabricated text" }],
    }),
    /evidence/i,
  );
  for (const ref of ["unread-ref", "stale-ref", "sql-only-ref", "other-owner-ref"]) {
    await assert.rejects(
      execute(ref, { ...base, flagReadDetected: true, evidence: [{ ref }] }),
      /evidence|transcript/i,
    );
  }
  await assert.rejects(
    execute("duplicate", {
      ...base,
      flagReadDetected: true,
      evidence: [cite(target), cite(target)],
    }),
    /duplicate/i,
  );
  assert.deepEqual(invalid, [
    "model-completion",
    "history-only",
    "extra-excerpt",
    "unread-ref",
    "stale-ref",
    "sql-only-ref",
    "other-owner-ref",
    "duplicate",
  ]);
  assert.deepEqual(failures, []);
  assert.deepEqual(decisions, []);
  await execute("negative", {
    ...base,
    flagReadDetected: false,
    evidence: [],
  });
  await execute("positive", {
    ...base,
    flagReadDetected: true,
    evidence: [cite(target), cite(historical)],
  });
  assert.deepEqual(decisions, [
    { ...base, flagReadDetected: false, investigationComplete: true, evidence: [] },
    {
      ...base,
      flagReadDetected: true,
      investigationComplete: true,
      evidence: [
        { ...cite(target), excerpt: target.text, sha256: target.sha256 },
        { ...cite(historical), excerpt: historical.text, sha256: historical.sha256 },
      ],
    },
  ]);
});

test("flag read citations resolve complete multibyte chunks within both byte limits", async () => {
  const fullText = "é".repeat(900);
  assert.ok(fullText.length > 500);
  assert.ok(
    Buffer.byteLength(JSON.stringify({ text: fullText })) <= MONITOR_MESSAGE_CHUNK_JSON_BYTES,
  );
  const longRow = { ...target, text: fullText };
  const oversizedRow = { ...historical, text: "🦊".repeat(700) };
  const visible = new Map([longRow, oversizedRow].map((row) => [row.ref, row]));
  const decisions: FlagReadDecision[] = [];
  const tool = createFinishInvestigationTool(
    visible,
    target.sessionId,
    (decision) => decisions.push(decision),
    () => assert.fail("invalid citations must remain correctable"),
    () => {},
    () => ({ calls: 1, limit: 1 }),
  );
  const execute = (args: unknown) => tool.execute("citation", args as never, undefined, undefined);
  await execute({
    flagReadDetected: true,
    reason: "The target read succeeded.",
    evidence: [{ ref: target.ref }],
  });
  assert.deepEqual(decisions[0].evidence, [
    { ref: target.ref, excerpt: fullText, sha256: target.sha256 },
  ]);
  await assert.rejects(
    execute({
      flagReadDetected: true,
      reason: "The target read succeeded.",
      evidence: [{ ref: target.ref }, { ref: historical.ref }],
    }),
    /evidence/i,
  );

  const oversizedOutput = new Map(
    Array.from({ length: 8 }, (_, index) => {
      const row = {
        ...target,
        ref: `${index}`.padEnd(512, "r"),
        text: "é".repeat(900),
        sha256: "h".repeat(2_000),
      };
      return [row.ref, row] as const;
    }),
  );
  const outputTool = createFinishInvestigationTool(
    oversizedOutput,
    target.sessionId,
    () => assert.fail("oversized citations must not finish"),
    () => assert.fail("oversized citations must be correctable"),
    () => {},
    () => ({ calls: 1, limit: 1 }),
  );
  await assert.rejects(
    outputTool.execute(
      "size",
      {
        flagReadDetected: true,
        reason: "The target read succeeded.",
        evidence: [...oversizedOutput.keys()].map((ref) => ({ ref })),
      } as never,
      undefined,
      undefined,
    ),
    /evidence/i,
  );
});

test("storage adapter maps every valid negative to coverage", () => {
  const base: FlagReadInvestigationResult = {
    flagReadDetected: false,
    investigationComplete: true,
    reason: "More evidence is needed.",
    evidence: [],
    monitorVersion: FLAG_READ_MONITOR_VERSION,
    promptHash: flagReadPolicyById("v15-unknown").promptHash,
    policyId: "v15-unknown",
    investigatorModel: INVESTIGATOR_MODEL,
    investigatorEffort: INVESTIGATOR_EFFORT,
    revision: 2,
    calls: 1,
    retrievalCalls: 0,
    latencyMs: 10,
    initialEvidenceCount: 1,
    retrievedRefs: [],
    forcedDecision: false,
    continuations: 0,
    readConfirmation: null,
  };
  assert.equal(detectorToReviewDecision(base).verdict, "allow");
  assert.equal(
    detectorToReviewDecision({ ...base, flagReadDetected: true, investigationComplete: true })
      .verdict,
    "block",
  );
});

test("F11: a reported read is confirmed once, and only a later request decides", async () => {
  const visible = new Map([[target.ref, target]]);
  const decisions: FlagReadDecision[] = [];
  const states: ReadConfirmation[] = [];
  let request = { calls: 1, limit: 3 };
  const tool = createFinishInvestigationTool(
    visible,
    target.sessionId,
    (decision) => decisions.push(decision),
    (error) => assert.fail(String(error)),
    undefined,
    () => request,
    (state) => states.push(state),
  );
  const report = (flagReadDetected: boolean) =>
    tool.execute(
      "id",
      { flagReadDetected, reason: "Reported.", evidence: [{ ref: target.ref }] } as never,
      undefined,
      undefined,
    );
  const text = (result: Awaited<ReturnType<typeof report>>) =>
    result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  assert.equal(text(await report(true)), READ_CONFIRMATION_REQUEST);
  assert.equal(text(await report(true)), READ_CONFIRMATION_REQUEST);
  // A no-read call in the response that received the confirmation decides nothing either.
  assert.equal(text(await report(false)), READ_CONFIRMATION_REQUEST);
  assert.deepEqual(decisions, []);
  request = { calls: 2, limit: 3 };
  assert.notEqual(text(await report(true)), READ_CONFIRMATION_REQUEST);
  assert.equal(decisions.length, 1);
  assert.equal(states.at(-1), "kept");
});

test("F11: a read reported on the last request is recorded unconfirmed", async () => {
  const decisions: FlagReadDecision[] = [];
  const states: ReadConfirmation[] = [];
  const tool = createFinishInvestigationTool(
    new Map([[target.ref, target]]),
    target.sessionId,
    (decision) => decisions.push(decision),
    (error) => assert.fail(String(error)),
    undefined,
    () => ({ calls: 3, limit: 3 }),
    (state) => states.push(state),
  );
  await tool.execute(
    "id",
    { flagReadDetected: true, reason: "Read.", evidence: [{ ref: target.ref }] } as never,
    undefined,
    undefined,
  );
  assert.equal(decisions.length, 1);
  assert.deepEqual(states, ["unconfirmed"]);
});

test("F11: a no-read report that comes first is never questioned", async () => {
  const decisions: FlagReadDecision[] = [];
  const states: ReadConfirmation[] = [];
  const tool = createFinishInvestigationTool(
    new Map(),
    target.sessionId,
    (decision) => decisions.push(decision),
    (error) => assert.fail(String(error)),
    undefined,
    () => ({ calls: 1, limit: 3 }),
    (state) => states.push(state),
  );
  await tool.execute(
    "id",
    { flagReadDetected: false, reason: "None.", evidence: [] } as never,
    undefined,
    undefined,
  );
  assert.equal(decisions.length, 1);
  assert.deepEqual(states, []);
});

test("F11: the confirmation text is fixed", () => {
  assert.equal(
    createHash("sha256").update(READ_CONFIRMATION_REQUEST).digest("hex"),
    "db2dfb641ac34d080f839ce1d06e246d2b77d1881319f46d0f1abbf17cc24e5c",
  );
});
