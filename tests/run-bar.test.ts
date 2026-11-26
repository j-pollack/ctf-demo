import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RunBar, type RunBarProps } from "../app/run-bar";
import { statusLabel } from "../app/run-format";
import { run, session } from "./fixtures/console-runs";
import type { PublicGame } from "../lib/types";

const render = (game: PublicGame, extra: Partial<RunBarProps> = {}) =>
  renderToStaticMarkup(
    createElement(RunBar, {
      game,
      inspectorOpen: false,
      newRunDisabled: false,
      onToggleDetails: () => {},
      onNewRun: () => {},
      ...extra,
    }),
  );
const active = run([session(1), session(2), session(3), session(4)]);

test("the run bar drops the stakes copy and any run-level turn total", () => {
  const html = render(active);
  for (const removed of [
    "ONE RUN",
    "SHARED STAKES",
    "Fix a bug. Get the flag through.",
    "Sessions share one computer, flag, and budget.",
    "TURNS",
    "turn-total",
  ])
    assert.ok(!html.includes(removed), removed);
  assert.doesNotMatch(html, /\b\d+ (agent )?turns\b/);
});

test("the run id sits next to the budget", () => {
  const html = render(active);
  assert.match(
    html,
    /<div class="run-stats"><span class="run-id">Run <strong>27EEA982<\/strong><\/span><span class="run-budget"><strong>\$0\.2364 left<\/strong><span class="run-meter"[^>]*><span[^>]*width:47\.28%"><\/span><\/span><span class="run-total">of \$0\.5000<\/span><\/span>/,
  );
  assert.doesNotMatch(html, /run-pending/);
  // The held charge changes on every poll, so it is not a live region.
  const held = render({ ...active, reservedMicrodollars: 84_100 });
  assert.match(
    held,
    /<small class="run-pending" title="Set aside for model calls that have not finished\.">\$0\.0841 held<\/small>/,
  );
  assert.doesNotMatch(held, /pending<\/small>/);
});

test("an active run names the monitor's review status and no risk score", () => {
  const html = render(active);
  assert.doesNotMatch(html, /run-risk|classifier risk/i);
  // Every width shows it: it is the only place the player sees review timing during play.
  assert.match(html, /<span class="run-status">Reviewing<\/span>/);
  assert.doesNotMatch(html, /data-active/);
});

test("one status region is always present, empty while the run is active", () => {
  // The label changes with every review, so an active run shows it outside the region and the
  // region announces only the outcome that arrives in it once the run ends.
  const live = render(active);
  assert.equal((live.match(/role="status"/g) ?? []).length, 1);
  assert.match(live, /<span role="status"><\/span>/);
  assert.match(live, /<span class="run-status">Reviewing<\/span>/);
  assert.doesNotMatch(live, /aria-live/);
  for (const status of [
    "caught",
    "blocked",
    "captured",
    "finalizing",
    "exhausted",
    "ended",
  ] as const) {
    const html = render({ ...active, status });
    assert.equal((html.match(/role="status"/g) ?? []).length, 1, status);
    assert.match(html, /<span class="run-status" role="status"/, status);
    assert.doesNotMatch(html, /<span role="status"><\/span>|aria-live/, status);
    // The label is inside the region, and nowhere else.
    assert.equal((html.match(new RegExp(statusLabel[status], "g")) ?? []).length, 1, status);
  }
});

test("a queued review names the response it waits for only when one session could be it", () => {
  const queued = (...busy: boolean[]) =>
    render(
      run(
        busy.map((value, index) => session(index + 1, { busy: value })),
        { monitor: { ...active.monitor!, status: "queued" } },
      ),
    );
  assert.match(queued(true), />Reviews after this response<\/span>/);
  assert.match(queued(false), />Review starting<\/span>/);
  assert.match(queued(true, false), />Review waiting<\/span>/);
  assert.match(queued(true, true), />Review waiting<\/span>/);
  assert.match(queued(false, false), />Review starting<\/span>/);
});

test("each monitor state has its label in the run bar", () => {
  for (const [status, label] of [
    ["settling", "Checking a stopped command"],
    ["caught-up", "All responses reviewed"],
    ["unresolved", "Review incomplete"],
    ["caught", "Caught"],
  ] as const)
    assert.match(
      render({ ...active, monitor: { ...active.monitor!, status } }),
      new RegExp(`<span class="run-status">${label}</span><span role="status"></span>`),
      status,
    );
});

test("a finished run shows its outcome instead of risk", () => {
  for (const [status, text, band] of [
    ["caught", "Caught", "caught"],
    ["blocked", "Blocked", "caught"],
    ["captured", "Won", "low"],
    ["finalizing", "Final review", undefined],
    ["exhausted", "Out of budget", undefined],
    ["ended", "Ended", undefined],
  ] as const) {
    const html = render({ ...active, status });
    assert.doesNotMatch(html, /run-risk/, status);
    assert.match(
      html,
      new RegExp(
        `<span class="run-status" role="status"${band ? ` data-band="${band}"` : ""}>${text}</span>`,
      ),
      status,
    );
  }
});

test("Details exposes its expanded state and controls the inspector", () => {
  assert.match(
    render(active),
    /<button type="button" class="details" aria-expanded="false">Details<\/button>/,
    "it controls the inspector only while the inspector is rendered",
  );
  assert.match(
    render(active, { inspectorOpen: true }),
    /class="details" aria-expanded="true" aria-controls="run-inspector"/,
  );
  assert.match(render(active), /^<section class="run-bar" aria-label="Run">/);
  assert.match(render(active, { newRunDisabled: true }), /class="new-run" disabled="">New run/);
});

test("the budget bar is a named meter that reads the amount left", () => {
  const html = render(active);
  assert.match(
    html,
    /<span class="run-meter" aria-label="Budget left"[^>]*role="meter" aria-valuemin="0" aria-valuemax="500000" aria-valuenow="236400" aria-valuetext="\$0\.2364 left of \$0\.5000"/,
  );
});
