import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FeedbackThreadView } from "../app/admin/feedback/[id]/feedback-thread";
import { MESSAGE_MAX } from "../lib/feedback-limits";
import type { FeedbackThread } from "../lib/feedback-mail";

const GAME = "11111111-2222-4333-8444-555555555555";
const SESSION = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const row = {
  id: "row-1",
  kind: "contact",
  name: "Ada <b>",
  email: "ada@example.com",
  accountEmail: null,
  message: "stored <script>alert(1)</script>",
  gameId: null,
  sessionId: null,
  ordinal: null,
  createdAt: new Date("2026-11-25T08:09:00Z"),
  mailThreadId: "T1",
  closedAt: null,
};
const message = (over = {}) => ({
  from: "Evil <i>@example.com",
  at: new Date("2026-11-25T09:00:00Z"),
  text: "https://example.com <img src=x onerror=alert(1)>",
  ours: false,
  truncated: false,
  htmlOnly: false,
  ...over,
});
const action = async () => {};
// React appends its own form-replay script to a page with server action forms.
const render = (thread: Partial<FeedbackThread> = {}, error?: "reply" | "close") =>
  renderToStaticMarkup(
    createElement(FeedbackThreadView, {
      thread: { row, note: null, messages: [message({ ours: false })], ...thread },
      error,
      reply: action,
      close: action,
    }),
  ).replace(/<script>addEventListener[\s\S]*<\/script>$/, "");

test("M16: mail text, names and addresses render as escaped plain text", () => {
  const html = render({
    messages: [
      message({ text: row.message }),
      message(),
      message({ ours: true, from: "contact@example.com" }),
    ],
  });
  assert.match(html, /Ada &lt;b&gt;/);
  assert.match(html, /Evil &lt;i&gt;@example\.com/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /stored &lt;script&gt;/);
  assert.doesNotMatch(html, /<img|<script|<b>|<i>|href="https:|<a href="(?!\/admin)/);
  // The side as shown in the text. The data-state attribute repeats it and is left out.
  const shown = html.replace(/ data-state="[^"]*"/g, "");
  assert.match(shown, /theirs/);
  assert.match(shown, /ours/);
});

test("M16: the reply field is labelled, required and length limited, and the typed address is unverified", () => {
  const html = render();
  assert.match(html, /<label for="reply-text">Reply<\/label>/);
  const field = html.match(/<textarea[^>]*id="reply-text"[^>]*>/)?.[0];
  assert.ok(field);
  assert.match(field, /\srequired=""/);
  assert.match(field, new RegExp(`maxLength="${MESSAGE_MAX}"`));
  assert.match(html, /ada@example\.com[^<]*<small>unverified/);
  assert.match(html, /aria-disabled="false"/);
});

test("M16: truncated and HTML-only messages say so", () => {
  const html = render({
    messages: [message({ truncated: true }), message({ htmlOnly: true, text: "" })],
  });
  assert.match(html, /truncated/);
  assert.match(html, /HTML message, open it in Fastmail/);
});

test("the page names the note, the run and session of a report, and the close button", () => {
  const report = {
    ...row,
    kind: "bug",
    email: null,
    accountEmail: "p@example.com",
    gameId: GAME,
    sessionId: SESSION,
    ordinal: 2,
  };
  const html = render({ row: report, note: "unreadable" });
  assert.match(html, /The email thread could not be read\./);
  assert.ok(html.includes(GAME) && html.includes(SESSION));
  assert.doesNotMatch(html, /unverified/);
  assert.match(html, />Close ticket</);
  assert.match(html, /data-state="waiting"[^>]*>Needs reply</);
  const closed = render({ row: { ...row, closedAt: new Date() } });
  assert.match(closed, />Reopen ticket</);
  assert.match(closed, /data-state="closed"[^>]*>Closed</);
  assert.match(html, /<a class="back-link" href="\/admin#inbox"[^>]*>Back to inbox<\/a>/);
  assert.match(render({ note: "not-set-up" }), /Email is not set up\./);
  assert.doesNotMatch(render({ note: "not-set-up" }), /reply-text/);
  assert.match(render({}, "reply"), /The reply was not sent/);
});
