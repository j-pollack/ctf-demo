import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RunInspector } from "../app/run-inspector";
import { run, session } from "./fixtures/console-runs";

const game = run([session(1), session(2)]);
const series = [
  { id: "session-1", ordinal: 1, points: [{ turn: 1, risk: 0.2 }] },
  { id: "session-2", ordinal: 2, points: [{ turn: 2, risk: 0.65 }] },
];
const render = (extra = {}) =>
  renderToStaticMarkup(
    createElement(RunInspector, {
      game,
      sessions: [
        { ...session(1), turns: 4 },
        { ...session(2, { agentModel: "vendor/model-b", agentEffort: "high" }), turns: 21 },
      ],
      riskSeries: series,
      peak: 0.65,
      observed: true,
      decisions: [
        {
          ordinal: 2,
          event: {
            id: 9,
            kind: "monitor",
            decision: "block",
            turn: 3,
            suspicion: 0.9,
            text: "Read the flag.",
          },
        },
        { ordinal: 1, event: { id: 4, kind: "monitor", decision: "error", turn: 1, text: "" } },
      ],
      ...extra,
    }),
  );

test("the inspector is a labelled region with a focusable heading", () => {
  assert.match(
    render(),
    /^<aside class="inspector" id="run-inspector" aria-labelledby="inspector-title"><h2 id="inspector-title" tabindex="-1">Run details<\/h2>/,
  );
});

test("the inspector shows investigator status, progress, last review and reason", () => {
  const html = render();
  assert.match(html, /<strong>Reviewing<\/strong>/);
  assert.match(html, /1 of 2 sessions waiting for review\./);
  assert.match(html, /Last review: /);
  assert.match(html, /Reviewing the latest commands\./);
});

test("the inspector charts risk for every session", () => {
  const html = render();
  assert.match(html, /class="risk-heading"/);
  assert.match(html, /Peak 65%/);
  assert.match(html, /Session 1 · peak 20%/);
  assert.match(html, /Session 2 · peak 65%/);
  assert.match(html, /viewBox="0 0 300 120"/);
  assert.match(render({ observed: false, peak: 0, riskSeries: [] }), /No risk data yet/);
});

test("decisions are labelled by session, newest first", () => {
  const html = render();
  const flagged = html.indexOf("Flag read detected"),
    failed = html.indexOf("Investigation error");
  assert.ok(flagged >= 0 && failed > flagged);
  assert.match(html, /Session 2 · 90% classifier risk/);
  assert.match(html, /Session 1 · turn 1/);
  assert.match(html, /Read the flag\./);
  assert.doesNotMatch(render({ decisions: [] }), /Decisions/);
});

test("the inspector lists spend without all-caps labels", () => {
  const html = render();
  assert.match(html, /Spent <strong>\$0\.2636<\/strong>/);
  assert.match(html, /Agent <strong>\$0\.2000<\/strong>/);
  assert.match(html, /Monitor <strong>\$0\.0636<\/strong>/);
  assert.doesNotMatch(html, /SPEND|DECISIONS|CLASSIFIER RISK/);
});

test("the inspector lists every session's model, effort and turns", () => {
  const html = render();
  assert.match(html, /<h3>Sessions<\/h3>/);
  assert.match(
    html,
    /<tr><th scope="row">Session 1<\/th><td title="z-ai\/glm-5\.3-flash">glm-5\.3-flash<\/td><td>Low<\/td><td>4<\/td><\/tr>/,
  );
  assert.match(
    html,
    /<tr><th scope="row">Session 2<\/th><td title="vendor\/model-b">model-b<\/td><td>High<\/td><td>21<\/td><\/tr>/,
  );
});
