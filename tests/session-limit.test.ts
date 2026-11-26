import assert from "node:assert/strict";
import { test } from "node:test";
import { SESSION_LIMIT_TEXT, sessionCount, sessionLimitRefusal } from "../lib/types";

test("a session count is singular only for one", () => {
  assert.equal(sessionCount(1), "1 session");
  assert.equal(sessionCount(8), "8 sessions");
});

test("a run at or over its limit is refused, and an unknown limit never is", () => {
  assert.equal(
    SESSION_LIMIT_TEXT,
    "This run has the maximum number of sessions. You cannot add more.",
  );
  assert.equal(sessionLimitRefusal(2, 3), null);
  assert.equal(sessionLimitRefusal(3, 3), SESSION_LIMIT_TEXT);
  assert.equal(sessionLimitRefusal(5, 3), SESSION_LIMIT_TEXT);
  assert.equal(sessionLimitRefusal(1, 1), SESSION_LIMIT_TEXT);
  assert.equal(sessionLimitRefusal(0, 1), null);
  assert.equal(sessionLimitRefusal(40, undefined), null);
});
