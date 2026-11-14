import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DialogTitle, RunDialog, RunSetupNotes, runsLeftText } from "../app/run-dialog";

const render = (open: boolean, busy: boolean) =>
  renderToStaticMarkup(
    createElement(RunDialog, {
      open,
      busy,
      onClose: () => {},
      children: createElement(DialogTitle, null, "Start a run"),
    }),
  );

test("the run dialog is a named modal dialog with a close button", () => {
  const html = render(true, false);
  assert.match(html, /^<dialog [^>]*role="dialog"[^>]*aria-modal="true"/);
  const title = html.match(/aria-labelledby="([^"]+)"/)?.[1];
  assert.match(html, new RegExp(`<h2 data-slot="dialog-title" id="${title}">Start a run</h2>`));
  assert.match(html, /<div class="dialog-content"><button class="close" aria-label="Close dialog"/);
  assert.doesNotMatch(html, /class="close"[^>]*disabled/);
});

test("the close button is disabled while a run-level action is busy, and nothing renders closed", () => {
  assert.match(render(true, true), /<button class="close"[^>]*disabled=""/);
  assert.equal(render(false, false), "");
});

test("the dialog says how many new runs are left today", () => {
  assert.equal(runsLeftText(3), "You can start 3 more runs today.");
  assert.equal(runsLeftText(1), "You can start 1 more run today.");
  assert.equal(runsLeftText(0), "You have no runs left today.");
  assert.equal(runsLeftText(null), null, "an admin has no daily limit to report");
  assert.equal(runsLeftText(undefined), null, "nothing is claimed before the count is known");
});

test("the setup notes say what starting ends and what is left, and nothing else", () => {
  const notes = (props: Parameters<typeof RunSetupNotes>[0]) =>
    renderToStaticMarkup(createElement(RunSetupNotes, props));
  assert.equal(
    notes({ endsCurrent: true, runsLeft: 1, unusedRun: false }),
    "<p>Starting a new run ends your current one.</p><p>You can start 1 more run today.</p>",
  );
  assert.equal(
    notes({ endsCurrent: false, runsLeft: 0, unusedRun: false }),
    "<p>You have no runs left today.</p>",
  );
  assert.equal(notes({ endsCurrent: false, runsLeft: undefined, unusedRun: false }), "");
  assert.match(
    notes({ endsCurrent: true, runsLeft: 2, unusedRun: true }),
    /You already have an unused run\. Send it an instruction first\./,
  );
  assert.doesNotMatch(
    notes({ endsCurrent: true, runsLeft: 2, unusedRun: false }),
    /budget|investigator|difficulty/i,
  );
});
