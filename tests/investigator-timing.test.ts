import assert from "node:assert/strict";
import { test } from "node:test";
import { MONITOR_INITIAL_CONTEXT_MAX_BYTES, MONITOR_OUTPUT_TOKENS } from "../lib/monitor-evidence";
import {
  BOUNDED_INVESTIGATOR_POLICY,
  MONITOR_CALL_LIMIT,
  STREAM_IDLE_MS,
  resolveInvestigatorTiming,
} from "../lib/investigator-evaluation-policy";

test("omitted timing preserves the production investigation, classifier and claim limits", () => {
  assert.deepEqual(resolveInvestigatorTiming(), {
    deadlineMs: 600_000,
    classifierDeadlineMs: 15_000,
    annotationDeadlineMs: 10_000,
  });
  assert.equal(BOUNDED_INVESTIGATOR_POLICY.claimMs, 660_000);
  assert.ok(BOUNDED_INVESTIGATOR_POLICY.claimMs > BOUNDED_INVESTIGATOR_POLICY.deadlineMs);
  assert.equal(MONITOR_CALL_LIMIT, 32);
  assert.equal(MONITOR_INITIAL_CONTEXT_MAX_BYTES, 512_000);
  assert.equal(MONITOR_OUTPUT_TOKENS, 8_192);
  assert.ok(Object.isFrozen(BOUNDED_INVESTIGATOR_POLICY));
});

test("shorter timing is copied so a caller cannot change an admitted budget", () => {
  const input = { deadlineMs: 3_000, classifierDeadlineMs: 1_000, annotationDeadlineMs: 500 };
  const timing = resolveInvestigatorTiming(input);
  assert.deepEqual(timing, input);
  assert.ok(Object.isFrozen(timing));
  input.deadlineMs = 90_000;
  assert.equal(timing.deadlineMs, 3_000);
});

test("invalid and longer budgets are rejected independently", () => {
  for (const key of ["deadlineMs", "classifierDeadlineMs", "annotationDeadlineMs"] as const) {
    for (const value of [0, -1, 0.5, NaN, Infinity, BOUNDED_INVESTIGATOR_POLICY[key] + 1]) {
      assert.throws(
        () => resolveInvestigatorTiming({ ...BOUNDED_INVESTIGATOR_POLICY, [key]: value }),
        new RegExp(key),
      );
    }
  }
});

test("the idle bound is optional, at most the production bound, and copied", () => {
  assert.equal("streamIdleMs" in resolveInvestigatorTiming(), false);
  const base = { deadlineMs: 3_000, classifierDeadlineMs: 1_000, annotationDeadlineMs: 500 };
  assert.equal(resolveInvestigatorTiming({ ...base, streamIdleMs: 200 }).streamIdleMs, 200);
  assert.equal(
    resolveInvestigatorTiming({ ...base, streamIdleMs: STREAM_IDLE_MS }).streamIdleMs,
    45_000,
  );
  for (const value of [0, -1, 0.5, NaN, Infinity, STREAM_IDLE_MS + 1])
    assert.throws(
      () => resolveInvestigatorTiming({ ...base, streamIdleMs: value }),
      /streamIdleMs/,
    );
});
