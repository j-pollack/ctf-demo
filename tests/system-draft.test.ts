import { test } from "node:test";
import assert from "node:assert/strict";
import { nextSystemDraft, withStoredSystemPrompt } from "../app/game-ui";
import { systemPromptChange } from "../app/session-pane";
import { createSessionUIState } from "../app/session-ui-state";

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

test("each session's draft follows its own stored prompt only while untouched", () => {
  const views = {
    alpha: createSessionUIState({ id: "alpha", systemPrompt: "old" }),
    beta: {
      ...createSessionUIState({ id: "beta", systemPrompt: "old" }),
      systemPromptDraft: "mine",
    },
  };
  const alpha = withStoredSystemPrompt(views, "alpha", "new");
  assert.equal(alpha.alpha.systemPromptDraft, "new");
  assert.equal(alpha.alpha.systemPrompt, "new");
  const beta = withStoredSystemPrompt(alpha, "beta", "new");
  assert.equal(beta.beta.systemPromptDraft, "mine");
  assert.equal(beta.beta.systemPrompt, "new");
  assert.equal(withStoredSystemPrompt(beta, "beta", "new"), beta, "an unchanged prompt is a no-op");
  assert.equal(withStoredSystemPrompt(beta, "missing", "x"), beta);
  assert.equal(views.alpha.systemPromptDraft, "old", "inputs are not mutated");
});
