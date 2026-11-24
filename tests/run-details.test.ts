import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SystemPrompt } from "../app/session-pane";
import { RunInspector } from "../app/run-inspector";
import { RunRiskChart } from "../app/run-risk-chart";
import { run, session } from "./fixtures/console-runs";

test("run details drop the removed copy, and the review chart keeps its legend", () => {
  const html = renderToStaticMarkup(
    createElement(RunInspector, { game: run([session(1)]), decisions: [] }),
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
  assert.doesNotMatch(html, /viewBox="0 0 300 120"/, "no chart during play");
  const chart = renderToStaticMarkup(
    createElement(RunRiskChart, {
      series: [
        {
          id: "s1",
          ordinal: 1,
          points: [
            { review: 1, risk: 0.2 },
            { review: 2, risk: 0.65 },
          ],
        },
      ],
    }),
  );
  assert.match(chart, /viewBox="0 0 300 120"/);
  assert.match(chart, /Session 1 · peak 65%/);
  assert.match(chart, /Session 1, review 2: 65%/);
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
    assert.match(html, /Visible to investigator/);
    assert.doesNotMatch(html, /hidden from|secret plan|never sees/i);
    if (editable) {
      assert.match(html, /aria-label="System prompt, visible to the investigator"/);
      assert.match(
        html,
        /placeholder="Optional\. The agent reads this every turn\. The investigator sees it too\."/,
      );
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
