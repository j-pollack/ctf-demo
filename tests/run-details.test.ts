import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SystemPrompt } from "../app/session-pane";
import { RunInspector } from "../app/run-inspector";
import { run, session } from "./fixtures/console-runs";

test("run details drop the removed copy and keep the chart and legend", () => {
  const html = renderToStaticMarkup(
    createElement(RunInspector, {
      game: run([session(1)]),
      sessions: [],
      riskSeries: [
        {
          id: "s1",
          ordinal: 1,
          points: [
            { turn: 1, risk: 0.2 },
            { turn: 2, risk: 0.65 },
          ],
        },
      ],
      peak: 0.65,
      observed: true,
      decisions: [],
    }),
  );
  for (const removed of [
    "Highest recorded score",
    "No classifier scores recorded",
    "Each trace shows one session",
    "share one computer, flag, and budget",
    "hasn’t confirmed yet",
    "suspicion-peak",
    "monitor-note",
    "CLASSIFIER RISK HISTORY",
  ])
    assert.ok(!html.includes(removed), removed);
  assert.match(html, /viewBox="0 0 300 120"/);
  assert.match(html, /Session 1 · peak 65%/);
});

test("system prompt sits outside any session settings wrapper", () => {
  const game = { systemPrompt: "The saved private plan." };
  for (const editable of [true, false]) {
    const html = renderToStaticMarkup(
      createElement(SystemPrompt, {
        game,
        editable,
        systemDraft: "The draft private plan.",
        changeSystemDraft: () => {},
        onPromptToggle: () => {},
      }),
    );
    assert.doesNotMatch(html, /Session settings|Unsaved prompt|run-settings|MODEL/);
    assert.match(html, /<details class="system-prompt"/);
    assert.match(html, /Hidden from investigator/);
    if (editable) {
      assert.match(html, /aria-label="System prompt, hidden from the investigator"/);
      assert.match(html, /The draft private plan\./);
      assert.match(html, /Sends with next instruction/);
    } else {
      assert.match(html, /The saved private plan\./);
      assert.doesNotMatch(html, /<textarea|Sends with next instruction/);
    }
  }
});

test("system prompt renders nothing when read-only and empty", () => {
  const html = renderToStaticMarkup(
    createElement(SystemPrompt, {
      game: { systemPrompt: "" },
      editable: false,
      systemDraft: "",
      changeSystemDraft: () => {},
      onPromptToggle: () => {},
    }),
  );
  assert.equal(html, "");
});
