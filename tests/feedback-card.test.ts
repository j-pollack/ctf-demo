import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FeedbackCard } from "../app/admin/feedback-card";
import { feedbackPage, type FeedbackRow } from "../lib/feedback";
import type { FeedbackState } from "../lib/feedback-mail-text";

const GAME = "11111111-2222-4333-8444-555555555555";
const SESSION = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const base: FeedbackRow = {
  id: "1",
  kind: "contact",
  name: "Ada <b>",
  email: "ada@example.com",
  accountEmail: null,
  message: "see https://example.com\n<script>alert(1)</script>",
  gameId: null,
  sessionId: null,
  ordinal: null,
  createdAt: new Date("2026-11-25T08:09:00Z"),
  mailThreadId: null,
  closedAt: null,
};
const render = (
  rows: FeedbackRow[],
  states: Record<string, FeedbackState> = {},
  page = 1,
  more = false,
) => renderToStaticMarkup(createElement(FeedbackCard, { rows, states, page, more }));

test("F15: a contact message shows its sender and text as plain text", () => {
  const html = render([base]);
  assert.match(html, /2026-11-25 08:09 UTC/);
  assert.match(html, /Contact form/);
  assert.match(html, /Ada &lt;b&gt;/);
  assert.match(html, /ada@example\.com/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script|<b>|href="(?!\/admin\/feedback\/1")/);
});

test("F15: a report shows the account, the full run id and the session", () => {
  const html = render([
    {
      ...base,
      kind: "monitor",
      name: null,
      email: null,
      accountEmail: "player@example.com",
      gameId: GAME,
      sessionId: SESSION,
      ordinal: 2,
    },
  ]);
  assert.match(html, /player@example\.com/);
  assert.ok(html.includes(GAME));
  assert.match(html, /Session 2/);
  assert.ok(html.includes(SESSION));
});

test("F15: an empty list says so", () => {
  assert.match(render([]), /No messages yet\./);
});

test("M16: each row links to its thread and shows the state when one is known", () => {
  const html = render([base, { ...base, id: "2" }], { "1": "answered" });
  assert.match(html, /<a class="thread-link" href="\/admin\/feedback\/1">/);
  assert.match(html, /<a class="thread-link" href="\/admin\/feedback\/2">/);
  assert.match(html, /answered/);
  assert.equal(html.match(/waiting|answered|closed/g)?.length, 1);
});

test("each row shows its status in words and links its thread", () => {
  const rows = ["1", "2", "3", "4"].map((id) => ({ ...base, id }));
  rows[3].closedAt = new Date();
  const html = render(rows, { "1": "waiting", "2": "answered" });
  assert.match(html, /data-state="waiting"[^>]*>Needs reply</);
  assert.match(html, /data-state="answered"[^>]*>Answered</);
  // Before Fastmail answers, a row is open or closed from the database alone.
  assert.match(html, /data-state="open"[^>]*>Open</);
  assert.match(html, /data-state="closed"[^>]*>Closed</);
  assert.match(html, /<a class="thread-link" href="\/admin\/feedback\/1">Open thread<\/a>/);
});

test("the inbox names its order and pages through older messages", () => {
  const one = render([base]);
  assert.match(one, /Open first, then newest/);
  assert.doesNotMatch(one, /Newest|Next page|Previous page/);
  const first = render([base], {}, 1, true);
  assert.match(first, /href="\/admin\?inbox=2#inbox"[^>]*>Next page</);
  assert.doesNotMatch(first, /Previous page/);
  const second = render([base], {}, 2, false);
  assert.match(second, /href="\/admin\?inbox=1#inbox"[^>]*>Previous page</);
  assert.doesNotMatch(second, /Next page/);
  assert.match(second, /Page 2/);
});

test("an inbox page number from the URL falls back to 1 unless it is a positive integer", () => {
  assert.equal(feedbackPage("3"), 3);
  for (const bad of [undefined, "", "0", "-2", "2.5", "abc", "1e400", ["2", "3"]])
    assert.equal(feedbackPage(bad), 1, String(bad));
});
