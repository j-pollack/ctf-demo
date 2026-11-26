import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FeedbackCard } from "../app/admin/feedback-card";
import type { FeedbackRow } from "../lib/feedback";
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
const render = (rows: FeedbackRow[], states: Record<string, FeedbackState> = {}) =>
  renderToStaticMarkup(createElement(FeedbackCard, { rows, states }));

test("F15: a contact message shows its sender and text as plain text", () => {
  const html = render([base]);
  assert.match(html, /2026-11-25 08:09 UTC/);
  assert.match(html, /contact/);
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
  assert.match(html, /<a href="\/admin\/feedback\/1">/);
  assert.match(html, /<a href="\/admin\/feedback\/2">/);
  assert.match(html, /answered/);
  assert.equal(html.match(/waiting|answered|closed/g)?.length, 1);
});
