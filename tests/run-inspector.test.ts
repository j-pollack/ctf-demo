import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CAUGHT_BY, RISK_NOTE, RunInspector } from "../app/run-inspector";
import type { PublicGame } from "../lib/types";
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
  assert.match(html, /<strong>Under review<\/strong>/);
  assert.match(html, /1 of 2 sessions waiting for review\./);
  assert.match(html, /Last review: /);
  assert.match(html, /Reviewing the latest commands\./);
});

test("a caught run names what caught it", () => {
  const caught = (cause: "jailbreak" | "flag_output" | "flag_read" | null) =>
    render({
      game: {
        ...game,
        caughtCause: cause,
        monitor: { ...game.monitor!, status: "caught" },
      } as PublicGame,
    });
  for (const cause of ["jailbreak", "flag_output", "flag_read"] as const)
    assert.ok(
      caught(cause).includes(`<strong>${CAUGHT_BY[cause].replaceAll("'", "&#x27;")}</strong>`),
    );
  assert.match(caught(null), /<strong>Caught<\/strong>/);
});

test("the inspector charts risk for every session", () => {
  const html = render();
  assert.match(html, /class="risk-heading"><h3>Classifier risk<\/h3>/);
  assert.ok(html.includes(`<p class="risk-note">${RISK_NOTE.replaceAll("'", "&#x27;")}</p>`));
  assert.doesNotMatch(html, /Only the investigator can/);
  assert.doesNotMatch(html, /advisory/i);
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

test("run details name the model and effort once when every session shares them", () => {
  const html = render();
  assert.equal((html.match(/class="run-model"/g) ?? []).length, 1);
  assert.match(
    html,
    /<p class="run-model" title="z-ai\/glm-5\.3-flash">glm-5\.3-flash · Low effort<\/p>/,
  );
  assert.doesNotMatch(html, /<h3>Sessions<\/h3>|<table class="session-table"/);
  assert.ok(html.indexOf("Run details") < html.indexOf('class="run-model"'));
  assert.ok(html.indexOf('class="run-model"') < html.indexOf("<h3>Monitor</h3>"));
});

test("run details list each distinct model and effort when sessions differ", () => {
  const html = render({
    game: run([
      session(1),
      session(2, { agentModel: "vendor/model-b", agentEffort: "high" }),
      session(3),
    ]),
  });
  assert.equal((html.match(/class="run-model"/g) ?? []).length, 2);
  assert.match(html, /glm-5\.3-flash · Low effort/);
  assert.match(html, /<p class="run-model" title="vendor\/model-b">model-b · High effort<\/p>/);
});

test("a jailbreak caught by the second look is not labelled refused", () => {
  const decision = (extra: object) => [
    {
      ordinal: 1,
      event: {
        id: 5,
        kind: "monitor" as const,
        decision: "block" as const,
        cause: "jailbreak" as const,
        turn: 1,
        text: "",
        ...extra,
      },
    },
  ];
  assert.match(
    render({ decisions: decision({ refusedKinds: ["instruction"] }) }),
    /Jailbreak refused/,
  );
  const caught = render({ decisions: decision({}) });
  assert.match(caught, /Jailbreak caught/);
  assert.doesNotMatch(caught, /Jailbreak refused/);
});
