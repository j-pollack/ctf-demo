import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionTabs, sessionIsRunning, nextTabIndex } from "../app/session-tabs";

test("session status uses local work and never shows running after a terminal run", () => {
  assert.equal(sessionIsRunning("active", { busy: false }, { busy: true }), false);
  assert.equal(sessionIsRunning("active", { busy: true }, { busy: false }), true);
  assert.equal(sessionIsRunning("active", undefined, { busy: true }), true);
  assert.equal(sessionIsRunning("caught", { busy: true }, { busy: true }), false);
});

test("tab navigation wraps and supports Home and End", () => {
  assert.equal(nextTabIndex("ArrowRight", 2, 3), 0);
  assert.equal(nextTabIndex("ArrowLeft", 0, 3), 2);
  assert.equal(nextTabIndex("Home", 2, 3), 0);
  assert.equal(nextTabIndex("End", 0, 3), 2);
  assert.equal(nextTabIndex("Enter", 1, 3), null);
});

test("session tabs expose selection, panel linkage, running state, and new session", () => {
  const markup = renderToStaticMarkup(
    React.createElement(SessionTabs, {
      runStatus: "active",
      sessions: [
        { id: "first", ordinal: 1, busy: false },
        { id: "second", ordinal: 2, busy: true },
      ],
      sessionViews: {},
      selectedId: "first",
      panelId: "session-panel",
      onSelect: () => {},
      onCreate: () => {},
      creating: false,
    }),
  );
  assert.match(markup, /role="tablist"/);
  assert.match(markup, /role="tab"[^>]*aria-selected="true"[^>]*aria-controls="session-panel"/);
  assert.match(markup, /Session 2[^<]*<\/span>/);
  assert.match(markup, /Running/);
  assert.match(markup, /New session/);
});
