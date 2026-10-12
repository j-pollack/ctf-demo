import assert from "node:assert/strict";
import { test } from "node:test";
import { niceTicks } from "../app/admin/charts";

test("axis ticks are clean steps that cover the maximum", () => {
  assert.deepEqual(niceTicks(0), [0, 1]);
  assert.deepEqual(niceTicks(60), [0, 20, 40, 60]);
  assert.deepEqual(niceTicks(1235), [0, 500, 1000, 1500]);
  assert.deepEqual(niceTicks(24.6), [0, 10, 20, 30]);
  assert.deepEqual(niceTicks(0.9), [0, 0.25, 0.5, 0.75, 1]);
});
