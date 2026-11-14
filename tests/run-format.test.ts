import { test } from "node:test";
import assert from "node:assert/strict";
import { label, monitorStatusLabel } from "../app/run-format";

test("a model label drops the provider, or keeps an id that has none", () => {
  assert.equal(label("z-ai/glm-5.3-flash"), "glm-5.3-flash");
  assert.equal(label("glm-5.3-flash"), "glm-5.3-flash");
});

test("investigator status labels say what the review found, without the word that means losing", () => {
  assert.deepEqual(monitorStatusLabel, {
    queued: "Review queued",
    reviewing: "Under review",
    "caught-up": "Reviewed, nothing found",
    unresolved: "Review incomplete",
    caught: "Caught",
  });
  assert.doesNotMatch(monitorStatusLabel["caught-up"], /caught/i);
});
