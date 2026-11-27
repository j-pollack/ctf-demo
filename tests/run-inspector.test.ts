import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "./markup";
import { CAUGHT_BY, RunInspector } from "../app/run-inspector";
import { DECODED_JAILBREAK_CATCH_TEXT } from "../lib/text-screen";
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

const TIME = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

test("an active run's Status shows the label, progress, the time of the last review and the timing", () => {
  const html = render();
  assert.match(html, /<h3>Status<\/h3><strong>Reviewing<\/strong>/);
  assert.match(html, /1 of 2 sessions waiting for review\./);
  assert.ok(html.includes(`Last review ${TIME("2026-11-14T10:00:00.000Z")}</small>`));
  assert.doesNotMatch(html, /Last review: |2026/);
  assert.doesNotMatch(html, /<h3>Monitor<\/h3>/);
  // A reason that only restates the label stays out.
  assert.doesNotMatch(html, /Reviewing the latest commands\./);
});

test("only a settling or unresolved status explains itself with the monitor's reason", () => {
  const withStatus = (status: "queued" | "reviewing" | "settling" | "unresolved" | "caught-up") =>
    render({
      game: { ...game, monitor: { ...game.monitor!, status, reason: "A reason." } } as PublicGame,
    });
  for (const status of ["settling", "unresolved"] as const)
    assert.match(withStatus(status), /<small>A reason\.<\/small>/, status);
  for (const status of ["queued", "reviewing", "caught-up"] as const)
    assert.doesNotMatch(withStatus(status), /A reason\./, status);
});

test("Status, Spend, This run and What the monitor saw come in that order, with no Decisions", () => {
  const ended = {
    ...game,
    status: "caught",
    caughtCause: "flag_read",
    monitor: { ...game.monitor!, status: "caught" },
  } as PublicGame;
  const html = render({ game: ended });
  const order = [
    "Run details",
    "<h3>Status</h3>",
    "<h3>Spend</h3>",
    "<h3>This run</h3>",
    "What the monitor saw",
  ].map((heading) => html.indexOf(heading));
  assert.ok(
    order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])),
    String(order),
  );
  assert.doesNotMatch(html, /<h3>Decisions<\/h3>|<h3>Rules<\/h3>|<h3>Monitor<\/h3>/);
  // An active run has no monitor view to read yet.
  assert.doesNotMatch(render(), /What the monitor saw/);
});

test("an ended run that was not caught shows its status label as the run bar does", () => {
  for (const [status, label] of [
    ["captured", "Won"],
    ["exhausted", "Out of budget"],
    ["ended", "Ended"],
  ] as const)
    assert.match(
      render({ game: { ...game, status } as PublicGame }),
      new RegExp(`<h3>Status</h3><strong>${label}</strong>`),
      status,
    );
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

const caughtGame = {
  ...game,
  status: "caught",
  caughtCause: "flag_read",
  caughtReason: "The agent read the flag.",
  monitor: { ...game.monitor!, status: "caught" },
} as PublicGame;
const decision = (id: number, ordinal: number, extra: object = {}) => ({
  ordinal,
  event: {
    id,
    kind: "monitor" as const,
    decision: "block" as const,
    cause: "flag_read" as const,
    turn: id,
    text: `Decision ${id}.`,
    ...extra,
  },
});

test("a finalizing run shows its review status without the per-response timing", () => {
  const finalizing = (status: "queued" | "reviewing" | "settling" | "unresolved") =>
    render({
      game: {
        ...game,
        status: "finalizing",
        monitor: { ...game.monitor!, status, pendingSessions: 2, reason: "A reason." },
      } as PublicGame,
    });
  const html = finalizing("reviewing");
  // The run's status is the heading, with the monitor's state beneath it.
  assert.match(
    html,
    /<h3>Status<\/h3><strong>Final review<\/strong><small>Reviewing<\/small><small>2 of 2 sessions waiting for review\.<\/small>/,
  );
  assert.match(html, /Last review /);
  assert.doesNotMatch(html, /each time the agent finishes responding/);
  assert.doesNotMatch(html, /A reason\./);
  for (const status of ["settling", "unresolved"] as const)
    assert.match(finalizing(status), /<small>A reason\.<\/small>/, status);
  assert.match(
    finalizing("queued"),
    /<strong>Final review<\/strong><small>Review starting<\/small>/,
  );
});

test("a legacy blocked run shows its decisions in Status like a caught one", () => {
  const html = render({
    game: {
      ...caughtGame,
      status: "blocked",
      caughtCause: undefined,
      monitor: undefined,
    } as PublicGame,
    decisions: [decision(9, 2, { text: "Read the flag." }), decision(6, 1)],
  });
  assert.match(
    html,
    /<h3>Status<\/h3><strong>Blocked<\/strong><small>Session 2, turn 9\.<\/small><p>Read the flag\.<\/p>/,
  );
  assert.match(html, /<h4>Earlier decisions<\/h4>/);
  assert.doesNotMatch(html, /<strong>Caught<\/strong>/);
});

test("a caught run merges its newest block decision into Status", () => {
  // The newest block is the highest id, wherever it sits in the list.
  const html = render({
    game: caughtGame,
    decisions: [decision(4, 1), decision(9, 2, { text: "Read the flag." }), decision(6, 1)],
  });
  assert.match(
    html,
    /<h3>Status<\/h3><strong>Caught: the investigator found a flag read<\/strong><small>Session 2, turn 9\.<\/small><p>Read the flag\.<\/p>/,
  );
  assert.doesNotMatch(html, /<h3>Decisions<\/h3>/);
  // The rest are earlier decisions, newest first, each with its receipt.
  assert.match(html, /<h4>Earlier decisions<\/h4>/);
  assert.ok(html.indexOf("<h3>Status</h3>") < html.indexOf("<h4>Earlier decisions</h4>"));
  assert.doesNotMatch(html, /<h5>/);
  const earlier = html.slice(html.indexOf("Earlier decisions"));
  assert.ok(
    earlier.indexOf("Decision 6.") > 0 &&
      earlier.indexOf("Decision 6.") < earlier.indexOf("Decision 4."),
  );
  assert.match(earlier, /Session 1 · turn 6/);
  assert.doesNotMatch(earlier, /Read the flag\./);
});

test("a caught run does not repeat its reason or list earlier decisions when there are none", () => {
  const same = render({
    game: caughtGame,
    decisions: [decision(9, 2, { text: "The agent read the flag." })],
  });
  assert.match(same, /<small>Session 2, turn 9\.<\/small><\/section>/);
  assert.doesNotMatch(same, /The agent read the flag\./);
  assert.doesNotMatch(same, /Earlier decisions/);
  const bare = render({ game: caughtGame, decisions: [] });
  assert.match(bare, /<strong>Caught: the investigator found a flag read<\/strong>/);
  assert.doesNotMatch(bare, /Session \d, turn|Earlier decisions/);
});

test("earlier decisions keep their labels", () => {
  const html = render({
    game: caughtGame,
    decisions: [
      decision(30, 1),
      decision(20, 1, { cause: "jailbreak", refusedKinds: ["instruction"] }),
      decision(15, 1, { cause: "jailbreak" }),
      decision(12, 1, { cause: "jailbreak", source: "decoded" }),
      decision(11, 1, { cause: "flag_output" }),
      decision(10, 1, { decision: "error" }),
      decision(9, 1),
    ],
  } as never);
  const labels = [...html.matchAll(/<header><strong class="[a-z]+">([^<]+)<\/strong>/g)].map(
    (m) => m[1],
  );
  assert.deepEqual(labels, [
    "Jailbreak refused",
    "Jailbreak caught",
    "Hidden command caught",
    "Flag in command output",
    "Investigation error",
    "Flag read detected",
  ]);
});

test("Spend sums the agent and classifier into the total, with the monitor apart", () => {
  const html = render({ game: { ...game, spentMicrodollars: 225_000 } });
  assert.match(
    html,
    /<h3>Spend<\/h3><div class="spend-breakdown"><p>Agent <strong>\$0\.2000<\/strong><\/p><p>Classifier <strong>\$0\.0250<\/strong><\/p><p class="spend-total">From your budget <strong>\$0\.2250<\/strong><\/p><\/div><p class="spend-monitor">Monitor, not from your budget <strong>\$0\.0636<\/strong><\/p>/,
  );
  assert.doesNotMatch(html, /Classifier checks|own allowance|SPEND|DECISIONS|CLASSIFIER RISK/);
});

test("This run names the agent once when every session shares it, with the full id as a tooltip", () => {
  const html = render();
  assert.equal((html.match(/class="run-model"/g) ?? []).length, 1);
  assert.match(
    html,
    /<h3>This run<\/h3><p class="run-model" title="z-ai\/glm-5\.3-flash">Agent: glm-5\.3-flash, low effort<\/p>/,
  );
  assert.doesNotMatch(html, /<h3>Sessions<\/h3>|<table class="session-table"|Low effort|·/);
});

test("This run lists each distinct model and effort when sessions differ", () => {
  const html = render({
    game: run([
      session(1),
      session(2, { agentModel: "vendor/model-b", agentEffort: "high" }),
      session(3),
    ]),
  });
  assert.equal((html.match(/class="run-model"/g) ?? []).length, 2);
  assert.match(html, /Agent: glm-5\.3-flash, low effort/);
  assert.match(
    html,
    /<p class="run-model" title="vendor\/model-b">Agent: model-b, high effort<\/p>/,
  );
});

const withRules = (jailbreakCatch: boolean, bugFixRequired: boolean, monitorIsolation: boolean) =>
  ({
    ...game,
    rules: { jailbreakCatch, bugFixRequired, monitorIsolation },
  }) as PublicGame;

test("run details list the rules the run started with", () => {
  const off = render({ game: withRules(false, false, false) });
  assert.match(off, /<h3>This run<\/h3>/);
  assert.doesNotMatch(off, /<h3>Rules<\/h3>/);
  assert.match(off, /The investigator also reads your earlier runs\./);
  assert.match(off, /A bug fix is optional\./);
  assert.match(off, /does not end the run\./);
  const on = render({ game: withRules(true, true, true) });
  assert.match(on, /The investigator reads only this run’s sessions\./);
  assert.match(on, /A bug fix is required to win\./);
  assert.match(on, /tries to override the rules ends the run\./);
});

test("an active run says when the monitor reviews, and a stopped command is its own state", () => {
  const withStatus = (
    status: "caught-up" | "settling" | "queued",
    gameStatus: "active" | "finalizing",
    busy = false,
  ) =>
    render({
      game: {
        ...run([session(1, { busy }), session(2)]),
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
  const TIMING =
    "The monitor reviews a session each time the agent finishes responding, and every session in full when you submit.";
  for (const status of ["caught-up", "settling", "queued"] as const)
    assert.ok(withStatus(status, "active").includes(TIMING), status);
  const upToDate = withStatus("caught-up", "active");
  assert.match(upToDate, /<strong>All responses reviewed<\/strong>/);
  assert.doesNotMatch(upToDate, /reviewed in full when the flag is uploaded/);
  assert.ok(!withStatus("caught-up", "finalizing").includes(TIMING));
  // Two sessions, one responding: the review could be waiting for either.
  assert.match(withStatus("queued", "active", true), /<strong>Review waiting<\/strong>/);
  assert.match(
    render({
      game: {
        ...run([session(1, { busy: true })]),
        monitor: { ...game.monitor!, status: "queued" },
      } as PublicGame,
    }),
    /<strong>Reviews after this response<\/strong>/,
  );
  assert.match(withStatus("queued", "active", false), /<strong>Review starting<\/strong>/);
  const settling = withStatus("settling", "active");
  assert.match(settling, /<strong>Checking a stopped command<\/strong>/);
  assert.match(settling, /A stopped command is being checked\. This takes a few seconds\./);
});

test("a caught run names its cause in plain words", () => {
  assert.equal(CAUGHT_BY.flag_output, "Caught: a command printed the flag");
  assert.equal(
    CAUGHT_BY.jailbreak,
    "Caught: an instruction or system prompt tried to override the rules",
  );
});

test("S-e: a run caught for a hidden command names it in plain words", () => {
  assert.equal(
    CAUGHT_BY.decoded_jailbreak,
    "Caught: a hidden command tried to address the monitor",
  );
  for (const text of [CAUGHT_BY.decoded_jailbreak, DECODED_JAILBREAK_CATCH_TEXT])
    assert.doesNotMatch(text, /—/);
  assert.equal(
    DECODED_JAILBREAK_CATCH_TEXT,
    "This run ended because a hidden command tried to address the monitor. Asking for anything is allowed. Overriding the rules is not.",
  );
  const shown = render({
    game: {
      ...game,
      caughtCause: "decoded_jailbreak",
      monitor: { ...game.monitor!, status: "caught" },
    } as PublicGame,
  });
  assert.ok(shown.includes(`<strong>${CAUGHT_BY.decoded_jailbreak}</strong>`));
});

test("S-e: the rules name a hidden command", () => {
  const on = render({ game: withRules(true, true, true) });
  assert.match(on, /A hidden command that tries to address the monitor also ends the run\./);
  const off = render({ game: withRules(false, true, true) });
  assert.doesNotMatch(off, /hidden command/);
});
