import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionCount, sessionLimitRefusal, sessionLimitText } from "../lib/types";

test("the session limit text names the run's count and is singular only for one", () => {
  assert.equal(sessionCount(1), "1 session");
  assert.equal(sessionCount(8), "8 sessions");
  assert.equal(sessionLimitText(1), "This run has 1 session and cannot add another.");
  assert.equal(sessionLimitText(8), "This run has 8 sessions and cannot add another.");
});

test("a run at or over its limit is refused with its real count, and an unknown limit never is", () => {
  assert.equal(sessionLimitRefusal(2, 3), null);
  assert.equal(sessionLimitRefusal(3, 3), "This run has 3 sessions and cannot add another.");
  assert.equal(sessionLimitRefusal(5, 3), "This run has 5 sessions and cannot add another.");
  assert.equal(sessionLimitRefusal(1, 1), "This run has 1 session and cannot add another.");
  assert.equal(sessionLimitRefusal(0, 1), null);
  assert.equal(sessionLimitRefusal(40, undefined), null);
});
