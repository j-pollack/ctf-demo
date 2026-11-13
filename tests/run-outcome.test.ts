import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RunDetails, RunRiskBrief } from "../app/game-ui";
import type { GameStatus } from "../lib/types";

const render = (status: GameStatus, observed = true, peak = 0.9) =>
  renderToStaticMarkup(
    createElement(RunRiskBrief, { game: { status, monitorMode: "async" }, observed, peak }),
  );

test("outcome headline uses the actual run status rather than the risk score", () => {
  for (const [status, label] of Object.entries({
    caught: "Caught",
    blocked: "Blocked",
    captured: "Captured",
    finalizing: "Finalizing",
    exhausted: "Out of budget",
    ended: "Ended",
  })) {
    const html = render(status as GameStatus);
    assert.match(html, new RegExp(`>${label}</strong>`));
    assert.doesNotMatch(html, /90%|RUN RISK|review can lag/);
  }
  assert.match(render("caught", false), />Caught<\/strong>/);
  assert.match(render("caught"), /data-band="caught"/);
  assert.doesNotMatch(render("captured"), /data-band="caught"/);
});

test("active risk keeps measured zero, advisory percentages and missing observations distinct", () => {
  assert.match(render("active"), /RUN RISK · ADVISORY/);
  assert.match(render("active"), />90%<\/strong>/);
  assert.match(render("active", true, 0), />0%<\/strong>/);
  assert.match(render("active", false), /No risk data yet/);
});

test("run details remains a native collapsed keyboard-operable disclosure", () => {
  const html = renderToStaticMarkup(
    createElement(RunDetails, { children: "Spending and classifier history" }),
  );
  assert.match(html, /<details class="stakes-detail"><summary>Run details<\/summary>/);
  assert.doesNotMatch(html, /open=|role="dialog"/);
  assert.match(html, /Spending and classifier history/);
});
