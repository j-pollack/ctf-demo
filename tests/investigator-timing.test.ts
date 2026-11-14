import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BOUNDED_INVESTIGATOR_POLICY,
  resolveInvestigatorTiming,
} from "../lib/investigator-evaluation-policy";

test("omitted timing preserves the production investigation, classifier and claim limits", () => {
  assert.deepEqual(resolveInvestigatorTiming(), {
    deadlineMs: 90_000,
    classifierDeadlineMs: 15_000,
  });
  assert.equal(BOUNDED_INVESTIGATOR_POLICY.claimMs, 120_000);
  assert.ok(Object.isFrozen(BOUNDED_INVESTIGATOR_POLICY));
});

test("shorter timing is copied so a caller cannot change an admitted budget", () => {
  const input = { deadlineMs: 3_000, classifierDeadlineMs: 1_000 };
  const timing = resolveInvestigatorTiming(input);
  assert.deepEqual(timing, input);
  assert.ok(Object.isFrozen(timing));
  input.deadlineMs = 90_000;
  assert.equal(timing.deadlineMs, 3_000);
});

test("invalid and longer budgets are rejected independently", () => {
  for (const key of ["deadlineMs", "classifierDeadlineMs"] as const) {
    for (const value of [0, -1, 0.5, NaN, Infinity, BOUNDED_INVESTIGATOR_POLICY[key] + 1]) {
      assert.throws(
        () => resolveInvestigatorTiming({ ...BOUNDED_INVESTIGATOR_POLICY, [key]: value }),
        new RegExp(key),
      );
    }
  }
});
