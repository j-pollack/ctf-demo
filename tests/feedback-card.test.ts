import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FeedbackCard } from "../app/admin/feedback-card";
import type { FeedbackRow } from "../lib/feedback";

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
};
const render = (rows: FeedbackRow[]) => renderToStaticMarkup(createElement(FeedbackCard, { rows }));

test("F15: a contact message shows its sender and text as plain text", () => {
  const html = render([base]);
  assert.match(html, /2026-11-25 08:09 UTC/);
  assert.match(html, /contact/);
  assert.match(html, /Ada &lt;b&gt;/);
  assert.match(html, /ada@example\.com/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script|<a |href=|<b>/);
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
