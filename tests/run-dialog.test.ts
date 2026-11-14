import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DialogTitle, RunDialog } from "../app/run-dialog";

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
