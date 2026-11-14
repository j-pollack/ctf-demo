import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RunBar, type RunBarProps } from "../app/run-bar";
import { run, session } from "./fixtures/console-runs";
import type { PublicGame } from "../lib/types";

const render = (game: PublicGame, extra: Partial<RunBarProps> = {}) =>
  renderToStaticMarkup(
    createElement(RunBar, {
      game,
      peak: 0.17,
      observed: true,
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
  // The pending charge changes on every poll, so it is not a live region.
  assert.match(
    render({ ...active, reservedMicrodollars: 84_100 }),
    /<small class="run-pending">\$0\.0841 pending<\/small>/,
  );
});

test("an active run shows advisory risk and the investigator status", () => {
  const html = render(active);
  assert.match(
    html,
    /<span class="run-risk" data-band="low" title="[^"]+" aria-label="Classifier risk 17%, advisory">Risk 17%<\/span>/,
  );
  // Marked active so narrow screens can drop it; the inspector also shows it.
  assert.match(html, /<span class="run-status" role="status" data-active="true">Reviewing<\/span>/);
  assert.match(render(active, { observed: false, peak: 0 }), />No risk data yet<\/span>/);
  assert.match(render(active, { peak: 0.75 }), /data-band="high"/);
});

test("a finished run shows its outcome instead of risk", () => {
  for (const [status, text, band] of [
    ["caught", "Caught", "caught"],
    ["blocked", "Blocked", "caught"],
    ["captured", "Captured", "low"],
    ["finalizing", "Finalizing", undefined],
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
