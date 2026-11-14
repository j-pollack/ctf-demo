import { test } from "node:test";
import assert from "node:assert/strict";
import * as UI from "../app/game-ui";

test("monitor progress text names sessions waiting for review", () => {
  for (const status of ["queued", "reviewing"] as const) {
    assert.equal(UI.monitorProgressText(status, 1, 1), "1 of 1 session waiting for review.");
    assert.equal(UI.monitorProgressText(status, 2, 3), "2 of 3 sessions waiting for review.");
  }
});

test("monitor progress text names sessions not fully reviewed", () => {
  assert.equal(UI.monitorProgressText("unresolved", 1, 1), "1 of 1 session not fully reviewed.");
  assert.equal(UI.monitorProgressText("unresolved", 2, 3), "2 of 3 sessions not fully reviewed.");
});

test("monitor progress text is fixed when caught up and absent when caught", () => {
  assert.equal(UI.monitorProgressText("caught-up", 0, 1), "All sessions reviewed.");
  assert.equal(UI.monitorProgressText("caught-up", 0, 3), "All sessions reviewed.");
  assert.equal(UI.monitorProgressText("caught", 1, 1), null);
  assert.equal(UI.monitorProgressText("caught", 2, 3), null);
});
