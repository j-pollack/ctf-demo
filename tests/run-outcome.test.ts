import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RunBar } from "../app/run-bar";
import { ReviewNotice, RunDialog } from "../app/run-dialog";
import { endBanner } from "../app/run-end";
import { UNVERIFIED_TEXT } from "../lib/async-finalization";
import { run, session } from "./fixtures/console-runs";
import type { GameStatus } from "../lib/types";

const render = (status: GameStatus) =>
  renderToStaticMarkup(
    createElement(RunBar, {
      game: run([session(1)], { status }),
      inspectorOpen: false,
      newRunDisabled: false,
      onToggleDetails: () => {},
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
  assert.match(render("caught"), /data-band="caught"/);
  assert.doesNotMatch(render("captured"), /data-band="caught"/);
});

test("an unverified run says the monitor could not clear it and it is not a win", () => {
  const details = {
    "unverified-review":
      "The monitor could not reach a decision on this run, so it could not clear it. That counts as flagged for a human, not a win. Start a new run to try again.",
    "unverified-allowance":
      "The monitor’s budget for this run ran out before every session was reviewed, so it could not clear this run. That counts as flagged for a human, not a win. Start a new run to try again.",
    "unverified-scoring":
      "Scoring could not be completed after repeated attempts, so this run could not be confirmed. It is not a win. Start a new run to try again.",
  } as const;
  for (const [reason, detail] of Object.entries(details)) {
    const banner = endBanner("ended", undefined, reason as keyof typeof details);
    assert.equal(banner.heading, "No result");
    assert.equal(banner.detail, detail);
  }
  assert.deepEqual(UNVERIFIED_TEXT, {
    review:
      "The monitor could not reach a decision, so it could not clear this run. This run ended with no result, which is not a win.",
    scoring: "Scoring could not be completed. This run ended with no result, which is not a win.",
    allowance:
      "The monitor’s budget ran out before every session was reviewed, so it could not clear this run. This run ended with no result, which is not a win.",
  });
  const fallback =
    "The review could not be completed. If the monitor cannot clear the run, it ends with no result, which is not a win.";
  const notice = renderToStaticMarkup(
    createElement(RunDialog, {
      open: true,
      busy: false,
      onClose: () => {},
      children: createElement(ReviewNotice, {
        unresolved: true,
        progress: null,
        onClose: () => {},
      }),
    }),
  );
  assert.ok(notice.includes(`<p>${fallback}</p>`), notice);
  for (const copy of [...Object.values(details), ...Object.values(UNVERIFIED_TEXT), fallback])
    assert.doesNotMatch(copy, /—|See How to win/, copy);
});
