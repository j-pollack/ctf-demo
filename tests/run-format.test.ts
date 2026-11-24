import { test } from "node:test";
import assert from "node:assert/strict";
import { label, monitorStatusLabel, runEndLabel } from "../app/run-format";

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
