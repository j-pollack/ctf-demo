import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as UI from "../app/game-ui";

const game = {
  agentModel: "vendor/model-a",
  agentEffort: "high" as const,
  monitorMode: "async" as const,
  spentMicrodollars: 3000,
  agentSpendMicrodollars: 2000,
  monitorSpendMicrodollars: 1000,
};
const series = [
  {
    id: "s1",
    ordinal: 1,
    points: [
      { turn: 1, risk: 0.2 },
      { turn: 2, risk: 0.65 },
    ],
  },
];
const decision = {
  id: 7,
  kind: "monitor" as const,
  decision: "block" as const,
  turn: 3,
  suspicion: 0.9,
  text: "Read the flag.",
};
const render = (props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(UI.RunDetailsContent, {
      game,
      ordinal: 2,
      riskSeries: series,
      peak: 0.65,
      observed: true,
      decisions: [],
      ...props,
    } as never),
  );

test("run details lists spend, session model, risk and decisions in order", () => {
  const html = render({ decisions: [decision] });
  const order = ["SPEND", "SESSION 2", "CLASSIFIER RISK · ADVISORY", "SESSION 2 DECISIONS"].map(
    (heading) => html.indexOf(heading),
  );
  assert.ok(
    order.every((index) => index >= 0),
    String(order),
  );
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
  );
  assert.match(html, /Spent <strong>\$0\.0030<\/strong>/);
  assert.match(html, /Agent <strong>\$0\.0020<\/strong>/);
  assert.match(html, /Monitor <strong>\$0\.0010<\/strong>/);
  assert.match(html, /Model model-a · High/);
  assert.match(html, /Flag read detected/);
  assert.match(html, /Read the flag\./);
});

test("run details shows the peak in the risk heading, or says there is no data", () => {
  assert.match(render(), /peak 65%/);
  const empty = render({ riskSeries: [], peak: 0, observed: false });
  assert.match(empty, /No risk data yet/);
  assert.doesNotMatch(empty, /peak \d+%/);
});

test("run details shows the decisions heading only when there are decisions", () => {
  assert.doesNotMatch(render(), /DECISIONS/);
  assert.match(render({ decisions: [decision] }), /SESSION 2 DECISIONS/);
});

test("run details drops the removed copy and keeps the chart and legend", () => {
  const html = render();
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
  assert.match(html, /viewBox="0 0 420 120"/);
  assert.match(html, /Session 1 · peak 65%/);
});

test("run details wraps its content in the overlay panel", () => {
  const html = renderToStaticMarkup(createElement(UI.RunDetails, { children: "Body" }));
  assert.match(
    html,
    /<details class="stakes-detail"><summary>Run details<\/summary><div class="stakes-panel">Body<\/div><\/details>/,
  );
});

test("system prompt sits outside any session settings wrapper", () => {
  const game = { systemPrompt: "The saved private plan." };
  for (const editable of [true, false]) {
    const html = renderToStaticMarkup(
      createElement(UI.SystemPrompt, {
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
    createElement(UI.SystemPrompt, {
      game: { systemPrompt: "" },
      editable: false,
      systemDraft: "",
      changeSystemDraft: () => {},
      onPromptToggle: () => {},
    }),
  );
  assert.equal(html, "");
});
