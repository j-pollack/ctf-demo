import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RunBar } from "../app/run-bar";
import { run, session } from "./fixtures/console-runs";
import type { GameStatus } from "../lib/types";

const render = (status: GameStatus, observed = true, peak = 0.9) =>
  renderToStaticMarkup(
    createElement(RunBar, {
      game: run([session(1)], { status }),
      observed,
      peak,
      inspectorOpen: false,
      newRunDisabled: false,
      onToggleDetails: () => {},
      onShowRisk: () => {},
      onNewRun: () => {},
    }),
  );

test("outcome headline uses the actual run status rather than the risk score", () => {
  for (const [status, label] of Object.entries({
    caught: "Caught",
    blocked: "Blocked",
    captured: "Won",
    finalizing: "Final review",
    exhausted: "Out of budget",
    ended: "Ended",
  })) {
    const html = render(status as GameStatus);
    assert.match(html, new RegExp(`>${label}</span>`));
    assert.doesNotMatch(html, /90%|RUN RISK|review can lag/);
  }
  assert.match(render("caught", false), />Caught<\/span>/);
  assert.match(render("caught"), /data-band="caught"/);
  assert.doesNotMatch(render("captured"), /data-band="caught"/);
});

test("active risk keeps measured zero, advisory percentages and missing observations distinct", () => {
  assert.match(render("active"), />Classifier risk 90%<\/button>/);
  assert.match(render("active", true, 0), />Classifier risk 0%<\/button>/);
  assert.match(render("active", false), />No classifier risk yet<\/button>/);
});
