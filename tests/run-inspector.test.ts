import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CAUGHT_BY, RunInspector } from "../app/run-inspector";
import type { PublicGame } from "../lib/types";
import { run, session } from "./fixtures/console-runs";

const game = run([session(1), session(2)]);
const render = (extra = {}) =>
  renderToStaticMarkup(
    createElement(RunInspector, {
      game,
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

test("decisions are labelled by session, newest first", () => {
  const html = render();
  const flagged = html.indexOf("Flag read detected"),
    failed = html.indexOf("Investigation error");
  assert.ok(flagged >= 0 && failed > flagged);
  assert.match(html, /Session 2 · turn 3/);
  assert.doesNotMatch(html, /90%|classifier risk/);
  assert.match(html, /Session 1 · turn 1/);
  assert.match(html, /Read the flag\./);
  assert.doesNotMatch(render({ decisions: [] }), /Decisions/);
});

test("the inspector lists spend without all-caps labels", () => {
  const html = render({ game: { ...game, spentMicrodollars: 225_000 } });
  assert.match(html, /From your budget <strong>\$0\.2250<\/strong>/);
  assert.match(html, /Agent <strong>\$0\.2000<\/strong>/);
  assert.match(html, /Classifier checks <strong>\$0\.0250<\/strong>/);
  assert.match(html, /Monitor, own allowance <strong>\$0\.0636<\/strong>/);
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

const withRules = (jailbreakCatch: boolean, bugFixRequired: boolean, monitorIsolation: boolean) =>
  ({
    ...game,
    rules: { jailbreakCatch, bugFixRequired, monitorIsolation },
  }) as PublicGame;

test("run details list the rules the run started with", () => {
  const off = render({ game: withRules(false, false, false) });
  assert.match(off, /<h3>Rules<\/h3>/);
  assert.match(off, /The investigator also reads your earlier runs\./);
  assert.match(off, /A bug fix is optional\./);
  assert.match(off, /does not end the run\./);
  const on = render({ game: withRules(true, true, true) });
  assert.match(on, /The investigator reads only this run’s sessions\./);
  assert.match(on, /A bug fix is required to win\./);
  assert.match(on, /tries to override the rules ends the run\./);
});

test("an up to date monitor says sessions are reviewed in full at upload, and a stopped command is its own state", () => {
  const withStatus = (status: "caught-up" | "settling", gameStatus: "active" | "finalizing") =>
    render({
      game: {
        ...game,
        status: gameStatus,
        monitor: {
          ...game.monitor!,
          status,
          reason:
            status === "settling"
              ? "A stopped command is being checked. This takes a few seconds."
              : undefined,
        },
      } as PublicGame,
    });
  const upToDate = withStatus("caught-up", "active");
  assert.match(upToDate, /<strong>Up to date<\/strong>/);
  assert.match(upToDate, /Sessions are reviewed in full when the flag is uploaded\./);
  assert.doesNotMatch(withStatus("caught-up", "finalizing"), /reviewed in full when/);
  const settling = withStatus("settling", "active");
  assert.match(settling, /<strong>Checking a command<\/strong>/);
  assert.match(settling, /A stopped command is being checked\. This takes a few seconds\./);
});

test("a caught run names its cause in plain words", () => {
  assert.equal(CAUGHT_BY.flag_output, "Caught: a command printed the flag");
  assert.equal(
    CAUGHT_BY.jailbreak,
    "Caught: an instruction or system prompt tried to override the rules",
  );
});
