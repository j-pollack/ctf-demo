import { test } from "node:test";
import assert from "node:assert/strict";
import { nextSystemDraft, systemPromptChange } from "../app/game-ui";

test("system prompt draft follows the stored value only while untouched", () => {
  const base = { baseId: "run", baseValue: "old" };
  // Untouched draft adopts a newer stored value (another tab saved it).
  assert.equal(nextSystemDraft({ ...base, draft: "old" }, { id: "run", stored: "new" }), "new");
  // An edited draft survives polling and refreshes, even when the stored value changes.
  assert.equal(nextSystemDraft({ ...base, draft: "mine" }, { id: "run", stored: "old" }), "mine");
  assert.equal(nextSystemDraft({ ...base, draft: "mine" }, { id: "run", stored: "new" }), "mine");
  // A different run resets the draft.
  assert.equal(nextSystemDraft({ ...base, draft: "mine" }, { id: "other", stored: "x" }), "x");
  assert.equal(nextSystemDraft({ baseValue: "", draft: "" }, { id: "run", stored: "x" }), "x");
});

test("only a changed draft is sent with an instruction", () => {
  assert.deepEqual(systemPromptChange("same", "same"), {});
  assert.deepEqual(systemPromptChange("", ""), {});
  assert.deepEqual(systemPromptChange("edited", "same"), { systemPrompt: "edited" });
  // Clearing a stored prompt is a change.
  assert.deepEqual(systemPromptChange("", "same"), { systemPrompt: "" });
});

test("a whitespace-only draft counts as empty, matching what the server stores", () => {
  assert.deepEqual(systemPromptChange("   ", ""), {});
  assert.deepEqual(systemPromptChange("  \n", ""), {});
  assert.deepEqual(systemPromptChange("  ", "S"), { systemPrompt: "" });
  assert.deepEqual(systemPromptChange("S", "S"), {});
  assert.deepEqual(systemPromptChange(" S ", "S"), { systemPrompt: " S " });
});
