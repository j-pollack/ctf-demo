import assert from "node:assert/strict";
import { test } from "node:test";
import { createFinishInvestigationTool, type FlagReadDecision } from "../lib/monitor-evidence";
import {
  detectorToReviewDecision,
  type FlagReadInvestigationResult,
} from "../lib/flag-read-investigator";
import { FLAG_READ_MONITOR_VERSION } from "../lib/control";
import { INVESTIGATOR_EFFORT, INVESTIGATOR_MODEL } from "../lib/investigator-driver";
import type { MonitorEvidenceMessage } from "../lib/monitor-tools";

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
  );
  const base = { reason: "A successful read is visible in the target tool result." };
  const cite = (row: MonitorEvidenceMessage) => ({
    ref: row.ref,
    excerpt: "completed command printed",
  });
  const execute = (id: string, args: unknown) =>
    tool.execute(id, args as never, undefined, undefined, {} as never);
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
    execute("forged", {
      ...base,
      flagReadDetected: true,
      evidence: [{ ref: target.ref, excerpt: "fabricated text" }],
    }),
    /evidence|excerpt/i,
  );
  assert.deepEqual(invalid, ["model-completion", "history-only", "forged"]);
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
    evidence: [cite(target)],
  });
  assert.deepEqual(decisions, [
    { ...base, flagReadDetected: false, investigationComplete: true, evidence: [] },
    {
      ...base,
      flagReadDetected: true,
      investigationComplete: true,
      evidence: [{ ...cite(target), sha256: target.sha256 }],
    },
  ]);
});

test("storage adapter maps every valid negative to coverage", () => {
  const base: FlagReadInvestigationResult = {
    flagReadDetected: false,
    investigationComplete: true,
    reason: "More evidence is needed.",
    evidence: [],
    monitorVersion: FLAG_READ_MONITOR_VERSION,
    investigatorModel: INVESTIGATOR_MODEL,
    investigatorEffort: INVESTIGATOR_EFFORT,
    revision: 2,
    calls: 1,
    retrievalCalls: 0,
    latencyMs: 10,
    initialEvidenceCount: 1,
    retrievedRefs: [],
  };
  assert.equal(detectorToReviewDecision(base).verdict, "allow");
  assert.equal(
    detectorToReviewDecision({ ...base, flagReadDetected: true, investigationComplete: true })
      .verdict,
    "block",
  );
});
