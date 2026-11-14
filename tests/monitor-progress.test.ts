import { test } from "node:test";
import assert from "node:assert/strict";
import * as UI from "../app/run-format";

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

test("monitor progress text is absent once every session is reviewed, and when caught", () => {
  // The status label already says the review found nothing.
  assert.equal(UI.monitorProgressText("caught-up", 0, 1), null);
  assert.equal(UI.monitorProgressText("caught-up", 0, 3), null);
  assert.equal(UI.monitorProgressText("caught", 1, 1), null);
  assert.equal(UI.monitorProgressText("caught", 2, 3), null);
});

test("monitor progress text is absent when no session is pending", () => {
  for (const status of ["unresolved", "queued", "reviewing"] as const)
    for (const total of [1, 3]) assert.equal(UI.monitorProgressText(status, 0, total), null);
});
