import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReportForm, reportBody } from "../app/report-problem";
import { MESSAGE_MAX } from "../lib/feedback-limits";
import { PENDING_SESSION } from "../app/session-layout";

const GAME = "11111111-2222-4333-8444-555555555555";
const SESSION = "66666666-7777-4888-8999-aaaaaaaaaaaa";

test("F17: the report names the run and the focused session", () => {
  assert.deepEqual(reportBody(GAME, SESSION, "monitor", "Wrong"), {
    kind: "monitor",
    gameId: GAME,
    sessionId: SESSION,
    message: "Wrong",
  });
});

test("F17: no session id goes out for the placeholder or no focus", () => {
  for (const focused of [PENDING_SESSION, null])
    assert.deepEqual(reportBody(GAME, focused, "bug", "x"), {
      kind: "bug",
      gameId: GAME,
      message: "x",
    });
});

test("F14: the report form has labelled fields and empty live regions", () => {
  const html = renderToStaticMarkup(createElement(ReportForm, { gameId: GAME, focusedId: null }));
  assert.match(html, /<label for="report-kind">What went wrong\?<\/label>/);
  const options = [...html.matchAll(/<option value="(\w+)"[^>]*>([^<]*)<\/option>/g)].map((m) => [
    m[1],
    m[2],
  ]);
  assert.deepEqual(options, [
    ["bug", "Something is broken"],
    ["monitor", "The monitor got it wrong"],
    ["other", "Something else"],
  ]);
  assert.match(html, /<label for="report-message">Message<\/label>/);
  const field = html.match(/<textarea[^>]*id="report-message"[^>]*>/)?.[0];
  assert.ok(field);
  assert.match(field, /\srequired=""/);
  assert.match(field, new RegExp(`maxLength="${MESSAGE_MAX}"`));
  assert.match(html, /Your run and session IDs are sent with the report\./);
  assert.match(html, /<p [^>]*role="alert"[^>]*><\/p>/);
  assert.match(html, /<button[^>]*>Send<\/button>/);
  // A disabled button drops keyboard focus, so a busy send is marked with aria-disabled only.
  assert.match(
    html,
    /<button class="primary" aria-disabled="false" data-testid="report-submit">Send<\/button>/,
  );
  assert.match(html, /<p [^>]*role="status"[^>]*><\/p>/);
});
