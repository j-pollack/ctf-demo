import { test } from "node:test";
import assert from "node:assert/strict";
import { dollars, label, monitorStatusLabel, newRuns, runEndLabel } from "../app/run-format";

test("a model label drops the provider, or keeps an id that has none", () => {
  assert.equal(label("z-ai/glm-5.3-flash"), "glm-5.3-flash");
  assert.equal(label("glm-5.3-flash"), "glm-5.3-flash");
});

test("investigator status labels say what the review found, without the word that means losing", () => {
  assert.deepEqual(monitorStatusLabel, {
    queued: "Review queued",
    reviewing: "Under review",
    settling: "Checking a command",
    "caught-up": "Up to date",
    unresolved: "Review incomplete",
    caught: "Caught",
  });
  assert.doesNotMatch(monitorStatusLabel["caught-up"], /caught/i);
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
