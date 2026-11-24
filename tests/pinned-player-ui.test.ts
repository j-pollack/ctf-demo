import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as UI from "../app/game-ui";
import { Entry } from "../app/transcript";
import { RunInspector } from "../app/run-inspector";
import { run, session } from "./fixtures/console-runs";

test("step-by-step rules describe starting a run without the removed difficulty setting", () => {
  const html = renderToStaticMarkup(
    createElement(UI.RunInstructions, { rules: run([session(1)]).rules }),
  );
  assert.match(html, /Start a run/);
  assert.doesNotMatch(html, /difficulty|\bEasy\b|\bMedium\b|\bHard\b/i);
  assert.match(html, /investigator can read the agent’s reasoning/);
  assert.match(html, /system prompt box/);
});

test("the inspector keeps each session's historical agent label and effort without difficulty", () => {
  const sessions = [
    {
      ...session(1, { agentModel: "historical/model-kept-for-this-session", agentEffort: "high" }),
      turns: 3,
    },
  ];
  const html = renderToStaticMarkup(
    createElement(RunInspector, {
      game: run(sessions, { status: "captured" }),
      decisions: [],
    }),
  );
  assert.match(html, /model-kept-for-this-session/);
  assert.match(html, /High/);
  assert.equal((html.match(/<select\b/g) ?? []).length, 0);
  assert.doesNotMatch(html, /DIFFICULTY|>Medium</);
  assert.doesNotMatch(html, />EFFORT<|>MODEL<\/span><select/);
});

test("truncated replies preserve reasoning and historical model without unavailable effort advice", () => {
  const html = renderToStaticMarkup(
    createElement(Entry, {
      event: {
        id: 1,
        kind: "agent",
        text: "Partial reply",
        reasoning: "Reasoning retained for the next turn.",
        model: "historical/previous-model",
        truncated: true,
      },
      showModel: true,
    }),
  );
  assert.match(html, /Reasoning retained for the next turn\./);
  assert.match(html, /previous-model/);
  assert.match(html, /ask for something smaller/i);
  assert.doesNotMatch(html, /Lower the agent effort|switch.*model/i);
});
