import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dollars,
  label,
  monitorStatusLabel,
  newRuns,
  runCount,
  runEndLabel,
} from "../app/run-format";

test("a model label drops the provider, or keeps an id that has none", () => {
  assert.equal(label("z-ai/glm-5.3-flash"), "glm-5.3-flash");
  assert.equal(label("glm-5.3-flash"), "glm-5.3-flash");
});

test("monitor status labels say what the review is doing, without the word that means losing", () => {
  const states = ["queued", "reviewing", "settling", "caught-up", "unresolved", "caught"] as const;
  const one = (busy: boolean) => [{ busy }];
  const labels = (sessions: { busy: boolean }[]) =>
    Object.fromEntries(states.map((state) => [state, monitorStatusLabel(state, sessions)]));
  assert.deepEqual(labels(one(false)), {
    queued: "Review starting",
    reviewing: "Reviewing",
    settling: "Checking a stopped command",
    "caught-up": "All responses reviewed",
    unresolved: "Review incomplete",
    caught: "Caught",
  });
  // A queued review names the response it waits for only when one session could be that response.
  assert.deepEqual(labels(one(true)), {
    ...labels(one(false)),
    queued: "Reviews after this response",
  });
  const several = (busy: boolean[]) => busy.map((value) => ({ busy: value }));
  assert.equal(monitorStatusLabel("queued", several([true, false])), "Review waiting");
  assert.equal(monitorStatusLabel("queued", several([true, true, false])), "Review waiting");
  assert.equal(monitorStatusLabel("queued", several([false, false])), "Review starting");
  assert.equal(monitorStatusLabel("queued", []), "Review starting");
  assert.deepEqual(labels(several([true, false])), {
    ...labels(one(false)),
    queued: "Review waiting",
  });
  assert.doesNotMatch(monitorStatusLabel("caught-up", one(false)), /caught/i);
});

test("My Runs says how an ended run ended, as the run page does", () => {
  assert.equal(runEndLabel({ status: "captured" }), "Won");
  assert.equal(runEndLabel({ status: "ended" }), "Ended");
  assert.equal(runEndLabel({ status: "ended", submissionCorrect: false }), "Wrong flag");
  assert.equal(
    runEndLabel({ status: "ended", submissionCorrect: true }),
    "Right flag, but no bug fixed",
  );
  for (const endReason of [
    "unverified-review",
    "unverified-scoring",
    "unverified-allowance",
  ] as const)
    assert.equal(runEndLabel({ status: "ended", submissionCorrect: true, endReason }), "No result");
  assert.equal(runEndLabel({ status: "caught", submissionCorrect: false }), "Caught");
});

test("dollars prints whole amounts bare and anything else with cents", () => {
  assert.equal(dollars(10_000_000), "$10");
  assert.equal(dollars(0), "$0");
  assert.equal(dollars(500_000), "$0.50");
  assert.equal(dollars(1_250_000), "$1.25");
  assert.equal(dollars(12_500_000), "$12.50");
  assert.equal(dollars(10_000), "$0.01");
});

test("newRuns is singular only for one", () => {
  assert.equal(newRuns(1), "1 new run");
  assert.equal(newRuns(3), "3 new runs");
  assert.equal(newRuns(0), "0 new runs");
});

test("runCount is singular only for one", () => {
  assert.equal(runCount(1), "1 run");
  assert.equal(runCount(3), "3 runs");
});
