import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionChips, type SessionChipsProps } from "../app/session-chips";
import { createSessionUIState } from "../app/session-ui-state";
import { session } from "./fixtures/console-runs";

const sessions = [
  session(1, { turns: 4 }),
  session(2, { turns: 5, busy: true }),
  session(3, { turns: 6 }),
  session(4, { turns: 21 }),
];
const render = (extra: Partial<SessionChipsProps> = {}) =>
  renderToStaticMarkup(
    createElement(SessionChips, {
      runStatus: "active",
      sessions,
      sessionViews: { "session-1": createSessionUIState({ id: "session-1", events: [] }) },
      shownIds: ["session-1", "session-4"],
      focusedId: "session-4",
      caughtSessionId: null,
      seen: { "session-2": 5, "session-3": 2 },
      onActivate: () => {},
      onCreate: () => {},
      creating: false,
      pendingOrdinal: null,
      ...extra,
    }),
  );
const chip = (html: string, ordinal: number) =>
  html.match(
    new RegExp(`<button[^>]*aria-controls="pane-session-${ordinal}"[^>]*>.*?</button>`),
  )?.[0] ??
  html.match(new RegExp(`<button[^>]*aria-label="Session ${ordinal},[^>]*>.*?</button>`))?.[0] ??
  "";

test("chips form a labelled toolbar, not a tablist", () => {
  const html = render();
  assert.match(html, /<div class="chips" role="toolbar" aria-label="Sessions">/);
  assert.doesNotMatch(html, /role="tab|aria-selected|aria-pressed/);
  assert.equal((html.match(/class="chip"/g) ?? []).length, 4);
});

test("only the focused chip is in the tab order and it is the current one", () => {
  const html = render();
  assert.match(chip(html, 4), /aria-current="true"/);
  assert.match(chip(html, 4), /tabindex="0"/);
  for (const ordinal of [1, 2, 3]) {
    assert.match(chip(html, ordinal), /tabindex="-1"/);
    assert.doesNotMatch(chip(html, ordinal), /aria-current/);
  }
});

test("chips mark shown, running, caught and unseen sessions without false attributes", () => {
  const html = render({ caughtSessionId: "session-1" });
  assert.match(chip(html, 1), /data-shown="true" data-caught="true"/);
  assert.match(chip(html, 1), /aria-label="Session 1, 4 turns, caught, shown"/);
  assert.match(chip(html, 2), /aria-label="Session 2, 5 turns, running, hidden"/);
  assert.match(chip(html, 2), /<i aria-hidden="true"><\/i>2</);
  assert.doesNotMatch(chip(html, 2), /data-shown|data-caught|data-unseen|false/);
  assert.match(chip(html, 3), /data-unseen="true"/);
  assert.match(chip(html, 3), /aria-label="Session 3, 6 turns, hidden, new turns"/);
  assert.doesNotMatch(chip(html, 3), /aria-controls/);
  assert.match(chip(html, 4), /aria-label="Session 4, 21 turns, focused"/);
});

test("a finished run shows no running chips", () => {
  assert.doesNotMatch(render({ runStatus: "caught" }), /running|<i /);
});

test("Add session sits outside the scrolling chips and only when a session can be added", () => {
  const html = render();
  assert.match(
    html,
    /<\/div><button type="button" class="chips-more" data-edge="end" aria-hidden="true" tabindex="-1" hidden="">›<\/button><\/div><button type="button" class="session-add" aria-label="Add session">\+<span class="add-label"> Add session<\/span><\/button>/,
  );
  assert.match(render({ creating: true }), /class="session-add"[^>]*aria-disabled="true"/);
  assert.doesNotMatch(render({ onCreate: undefined }), /session-add/);
});

test("Add session is enabled below the run's session limit and disabled with the reason at it", () => {
  const add = (html: string) => html.match(/<button type="button" class="session-add"[^>]*>/)![0];
  const below = add(render({ sessionLimit: 5 }));
  assert.doesNotMatch(below, /aria-disabled|title=/);
  assert.match(add(render({ sessionLimit: undefined })), /aria-label="Add session"/);
  for (const sessionLimit of [4, 3]) {
    const at = add(render({ sessionLimit }));
    assert.match(at, /aria-disabled="true"/);
    assert.match(at, /title="This run has the maximum number of sessions\. You cannot add more\."/);
    assert.doesNotMatch(
      at,
      / disabled=""/,
      "it is not natively disabled, so it stays focusable and a click can explain",
    );
  }
  const single = add(
    render({ sessions: [session(1)], sessionLimit: 1, shownIds: [], focusedId: "session-1" }),
  );
  assert.match(
    single,
    /title="This run has the maximum number of sessions\. You cannot add more\."/,
  );
});
