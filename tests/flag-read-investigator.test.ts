import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import {
  READ_CONFIRMATION_REQUEST,
  createFinishInvestigationTool,
  type FinishInvestigationOptions,
  type FlagReadDecision,
  type ReadConfirmation,
} from "../lib/monitor-evidence";
import { callsOfRow, type ReviewCall } from "../lib/investigator-trace";
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
  toolCallId: "call-target",
};
const targetCall: ReviewCall = {
  session: "target-session",
  observation: "o_target",
  index: 1,
  callId: "call-target",
  command: "cat /tmp/flag.txt",
  result: "The completed command printed the protected contents.",
  isError: false,
  sentAt: "2026-01-01T00:00:00.000Z",
  returnedAt: "2026-01-01T00:00:01.000Z",
  status: "ran",
};
const TRACE = '{"cited":[]}';
// The finish tool with a trace stub; each test overrides what it observes.
function finishTool(
  options: Partial<FinishInvestigationOptions> &
    Pick<FinishInvestigationOptions, "visible" | "finish" | "requests">,
) {
  return createFinishInvestigationTool({
    targetSessionId: target.sessionId,
    fail: (error) => assert.fail(String(error)),
    callsOfRow: (row) => callsOfRow([targetCall], row),
    trace: () => TRACE,
    ...options,
  });
}
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
  const tool = finishTool({
    visible,
    finish: (decision) => decisions.push(decision),
    fail: (error) => failures.push(error),
    onInvalid: (_error, id) => invalid.push(id),
    requests: () => ({ calls: 1, limit: 1 }),
  });
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
  const tool = finishTool({
    visible,
    finish: (decision) => decisions.push(decision),
    fail: () => assert.fail("invalid citations must remain correctable"),
    onInvalid: () => {},
    requests: () => ({ calls: 1, limit: 1 }),
  });
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
  const outputTool = finishTool({
    visible: oversizedOutput,
    finish: () => assert.fail("oversized citations must not finish"),
    fail: () => assert.fail("oversized citations must be correctable"),
    onInvalid: () => {},
    requests: () => ({ calls: 1, limit: 1 }),
  });
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
  const tool = finishTool({
    visible,
    finish: (decision) => decisions.push(decision),
    requests: () => request,
    onConfirmation: (state) => states.push(state),
  });
  const report = (flagReadDetected: boolean) =>
    tool.execute(
      "id",
      { flagReadDetected, reason: "Reported.", evidence: [{ ref: target.ref }] } as never,
      undefined,
      undefined,
    );
  const text = (result: Awaited<ReturnType<typeof report>>) =>
    result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  const asked = `${READ_CONFIRMATION_REQUEST}\n\n${TRACE}`;
  assert.equal(text(await report(true)), asked);
  assert.equal(text(await report(true)), asked);
  // A no-read call in the response that received the confirmation decides nothing either.
  assert.equal(text(await report(false)), asked);
  assert.deepEqual(decisions, []);
  request = { calls: 2, limit: 3 };
  assert.equal(text(await report(true)), "Investigation finished.");
  assert.equal(decisions.length, 1);
  assert.equal(states.at(-1), "kept");
});

test("F11: a read reported on the last request is recorded unconfirmed", async () => {
  const decisions: FlagReadDecision[] = [];
  const states: ReadConfirmation[] = [];
  const tool = finishTool({
    visible: new Map([[target.ref, target]]),
    finish: (decision) => decisions.push(decision),
    requests: () => ({ calls: 3, limit: 3 }),
    onConfirmation: (state) => states.push(state),
  });
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
  const tool = finishTool({
    visible: new Map(),
    finish: (decision) => decisions.push(decision),
    requests: () => ({ calls: 1, limit: 3 }),
    onConfirmation: (state) => states.push(state),
  });
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
    "f16b64edc9e1f7c4b1b0177f442db2d8148c0f576f24db4ea2a477b3d06a81cb",
  );
});

test("T1: a positive finding must cite a command or its result, and keeps the confirmation", async () => {
  const user: MonitorEvidenceMessage = {
    ...target,
    ref: "msg:user",
    role: "user",
    toolCallId: undefined,
  };
  const prose: MonitorEvidenceMessage = { ...user, ref: "msg:prose", role: "agent" };
  const other: MonitorEvidenceMessage = {
    ...prose,
    ref: "msg:other",
    toolCalls: [{ id: "call-other", name: "read_file" }],
  };
  const agent: MonitorEvidenceMessage = {
    ...prose,
    ref: "msg:agent#1",
    chunkIndex: 1,
    chunkCount: 2,
    toolCalls: [{ id: "call-target", name: "sprite_exec" }],
  };
  const firstChunk: MonitorEvidenceMessage = { ...agent, ref: "msg:agent", chunkIndex: 0 };
  const decisions: FlagReadDecision[] = [];
  const invalid: string[] = [];
  const tool = finishTool({
    visible: new Map([user, prose, other, firstChunk, agent, target].map((row) => [row.ref, row])),
    finish: (decision) => decisions.push(decision),
    onInvalid: (error) => invalid.push((error as Error).message),
    requests: () => ({ calls: 1, limit: 3 }),
  });
  const report = (ref: string) =>
    tool.execute("id", { flagReadDetected: true, reason: "Read.", evidence: [{ ref }] } as never);
  for (const row of [user, prose, other])
    await assert.rejects(report(row.ref), /must cite a target-session command or its result/);
  assert.equal(invalid.length, 3);
  // A later chunk of the agent message and a tool row both resolve to the call.
  for (const row of [firstChunk, agent, target]) {
    const result = await report(row.ref);
    assert.ok(result.content[0].type === "text" && result.content[0].text.endsWith(TRACE));
  }
  assert.equal(decisions.length, 0);
});

test("T1: a positive finding with no target row keeps the earlier message", async () => {
  const tool = finishTool({
    visible: new Map([[historical.ref, historical]]),
    finish: () => assert.fail("must not finish"),
    onInvalid: () => {},
    requests: () => ({ calls: 1, limit: 3 }),
  });
  await assert.rejects(
    tool.execute("id", {
      flagReadDetected: true,
      reason: "Read.",
      evidence: [{ ref: historical.ref }],
    } as never),
    /needs target-session evidence/,
  );
});
