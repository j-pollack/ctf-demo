import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DialogTitle,
  ReviewNotice,
  reviewNoticeOpen,
  RunDialog,
  RunSetupNotes,
  runsLeftText,
} from "../app/run-dialog";

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

test("the dialog says how many new runs are left under the limit on the last 24 hours", () => {
  assert.equal(runsLeftText(3), "You can start 3 more runs now.");
  assert.equal(runsLeftText(1), "You can start 1 more run now.");
  assert.equal(runsLeftText(0), "You have started 3 new runs in the last 24 hours.");
  assert.equal(runsLeftText(null), null, "an admin has no daily limit to report");
  assert.equal(runsLeftText(undefined), null, "nothing is claimed before the count is known");
});

test("the setup notes say what starting ends and what is left, and nothing else", () => {
  const notes = (props: Parameters<typeof RunSetupNotes>[0]) =>
    renderToStaticMarkup(createElement(RunSetupNotes, props));
  assert.equal(
    notes({ endsCurrent: true, runsLeft: 1, unusedRun: false }),
    "<p>Starting a new run ends your current one.</p><p>You can start 1 more run now.</p>",
  );
  assert.equal(
    notes({ endsCurrent: false, runsLeft: 0, unusedRun: false }),
    "<p>You have started 3 new runs in the last 24 hours.</p>",
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

test("a run waiting to be graded says so instead of promising it ends the run", () => {
  const html = renderToStaticMarkup(
    createElement(RunSetupNotes, {
      endsCurrent: true,
      grading: true,
      runsLeft: 2,
      unusedRun: false,
    }),
  );
  assert.match(
    html,
    /<p>Your current run’s upload is waiting to be graded\. You can start a new run once grading begins\.<\/p>/,
  );
  assert.doesNotMatch(html, /ends your current one/);
});

test("the review notice opens for a run awaiting its result until the player dismisses it", () => {
  assert.equal(reviewNoticeOpen({ id: "run-1", status: "finalizing" }, null), true);
  assert.equal(reviewNoticeOpen({ id: "run-1", status: "finalizing" }, "run-1"), false);
  assert.equal(
    reviewNoticeOpen({ id: "run-2", status: "finalizing" }, "run-1"),
    true,
    "dismissing one run's notice does not hide the next run's",
  );
  for (const status of ["active", "caught", "captured", "ended", "exhausted"] as const)
    assert.equal(reviewNoticeOpen({ id: "run-1", status }, null), false, status);
  assert.equal(reviewNoticeOpen(null, null), false);
});

test("the review notice says play has ended, who is reviewing what, and how to keep reading", () => {
  const notice = (props: Partial<Parameters<typeof ReviewNotice>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(RunDialog, {
        open: true,
        busy: false,
        onClose: () => {},
        children: createElement(ReviewNotice, {
          unresolved: false,
          progress: "1 of 4 sessions waiting for review.",
          onClose: () => {},
          ...props,
        }),
      }),
    );
  const pending = notice();
  assert.match(pending, />The investigator is reviewing this run<\/h2>/);
  assert.match(pending, /The flag was uploaded, so play has ended\./);
  assert.match(pending, /reading every session’s transcript before the result is confirmed/);
  assert.match(
    pending,
    /<p role="status" class="stage"><i aria-hidden="true"><\/i>1 of 4 sessions waiting for review\.<\/p>/,
  );
  assert.match(
    pending,
    /<button type="button" class="primary">Read the transcripts while you wait<\/button>/,
  );
  assert.match(notice({ progress: null }), /<\/i>Review in progress\.<\/p>/);
  const unresolved = notice({
    unresolved: true,
    reason: "Scoring could not be completed. The result remains unconfirmed.",
  });
  assert.match(unresolved, />Play has ended<\/h2>/);
  assert.match(
    unresolved,
    /<p>Scoring could not be completed\. The result remains unconfirmed\.<\/p>/,
  );
  assert.doesNotMatch(unresolved, /class="stage"|while you wait/);
  const settling = notice({
    unresolved: false,
    settling: true,
    reason: "A stopped command is being checked. This takes a few seconds.",
  });
  assert.match(settling, />The result is not ready yet<\/h2>/);
  assert.match(settling, /A stopped command is being checked\. This takes a few seconds\./);
  assert.doesNotMatch(settling, /review failed|could not be completed/);
  const retrying = notice({ unresolved: true, willRetry: true });
  assert.match(retrying, />The review failed<\/h2>/);
  assert.match(
    retrying,
    /The review failed and will be retried\. The result is not confirmed yet\./,
  );
});
