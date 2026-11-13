import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as UI from "../app/game-ui";

test("step-by-step rules describe starting a run without the removed difficulty setting", () => {
  const html = renderToStaticMarkup(createElement(UI.RunInstructions));
  assert.match(html, /Start a run/);
  assert.doesNotMatch(html, /difficulty|\bEasy\b|\bMedium\b|\bHard\b/i);
  assert.match(html, /investigator can read the agent’s reasoning/);
  assert.match(html, /system prompt box/);
});

test("actual setup fields show budget and reasoning guidance without difficulty selectors", () => {
  const html = renderToStaticMarkup(createElement(UI.RunSetupFields));
  assert.equal((html.match(/<select\b/g) ?? []).length, 0);
  assert.doesNotMatch(html, /difficulty|first instruction/i);
  assert.match(html, /budget/);
  assert.match(html, /investigator can read agent reasoning/);
  assert.doesNotMatch(html, /AGENT MODEL|AGENT EFFORT|change the agent.*model|effort at any time/);
});

test("actual session settings preserve prompts and historical agent labels without difficulty", () => {
  const game = {
    agentModel: "historical/model-kept-for-this-session",
    agentEffort: "high" as const,
    monitorDifficulty: "medium" as const,
    systemPrompt: "The saved private plan.",
  };
  for (const editable of [true, false]) {
    const html = renderToStaticMarkup(
      createElement(UI.SessionSettings, {
        game,
        editable,
        systemDraft: "The draft private plan.",
        changeSystemDraft: () => {},
        onPromptToggle: () => {},
      }),
    );
    assert.match(html, /model-kept-for-this-session/);
    assert.match(html, /High/);
    assert.match(html, /Hidden from investigator/);
    assert.equal((html.match(/<select\b/g) ?? []).length, 0);
    assert.doesNotMatch(html, /DIFFICULTY|>Medium</);
    assert.doesNotMatch(html, />EFFORT<|>MODEL<\/span><select/);
    if (editable) {
      assert.match(html, /aria-label="System prompt, hidden from the investigator"/);
      assert.match(html, /The draft private plan\./);
    } else {
      assert.match(html, /The saved private plan\./);
      assert.doesNotMatch(html, /<textarea/);
    }
  }
});

test("truncated replies preserve reasoning and historical model without unavailable effort advice", () => {
  const html = renderToStaticMarkup(
    createElement(UI.Entry, {
      event: {
        id: 1,
        kind: "agent",
        text: "Partial reply",
        reasoning: "Reasoning retained for the next turn.",
        model: "historical/previous-model",
        truncated: true,
      },
    }),
  );
  assert.match(html, /Reasoning retained for the next turn\./);
  assert.match(html, /previous-model/);
  assert.match(html, /ask for something smaller/i);
  assert.doesNotMatch(html, /Lower the agent effort|switch.*model/i);
});
