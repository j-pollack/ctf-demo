import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chipLabel,
  deckLayout,
  deckSessions,
  PENDING_SESSION,
  focusRecent,
  handOffFocus,
  nextSeenTurns,
  nextShownLoads,
  nextTabIndex,
  paneCapacity,
  sessionIsRunning,
  sessionTurns,
  shownSessionIds,
  stripEdges,
} from "../app/session-layout";
import type { GameEvent } from "../lib/types";

const ids = (count: number) => Array.from({ length: count }, (_, index) => `s${index + 1}`);

test("pane capacity is one pane per 400px, at least one, and one before measurement", () => {
  for (const [width, capacity] of [
    [null, 1],
    [0, 1],
    [399, 1],
    [400, 1],
    [799, 1],
    [800, 2],
    [1600, 4],
  ] as const)
    assert.equal(paneCapacity(width), capacity, String(width));
});

test("the inspector is closed before measurement and follows the player's choice after", () => {
  assert.deepEqual(deckLayout(null, 4, null), { capacity: 1, inspector: "closed" });
  assert.deepEqual(deckLayout(null, 4, true), { capacity: 1, inspector: "closed" });
  assert.deepEqual(deckLayout(1680, 4, true), { capacity: 3, inspector: "column" });
  assert.deepEqual(deckLayout(1392, 2, false), { capacity: 3, inspector: "closed" });
});

test("the inspector opens by default only when it costs no pane", () => {
  assert.deepEqual(deckLayout(1728 - 48, 4, null), { capacity: 4, inspector: "closed" });
  assert.deepEqual(deckLayout(1440 - 48, 2, null), { capacity: 2, inspector: "column" });
  assert.deepEqual(deckLayout(1728 - 48, 3, null), { capacity: 3, inspector: "column" });
  assert.deepEqual(
    deckLayout(700, 1, null),
    { capacity: 1, inspector: "closed" },
    "a one-pane deck keeps the inspector closed",
  );
});

test("an inspector without room for a pane beside it covers the deck", () => {
  assert.deepEqual(deckLayout(390 - 24, 10, true), { capacity: 1, inspector: "overlay" });
  assert.deepEqual(deckLayout(719, 2, true), { capacity: 1, inspector: "overlay" });
  assert.deepEqual(deckLayout(720, 2, true), { capacity: 1, inspector: "column" });
  assert.deepEqual(deckLayout(0, 1, true), { capacity: 1, inspector: "overlay" });
});

test("four sessions at capacity four all show; ten at capacity three show three", () => {
  assert.deepEqual(shownSessionIds(ids(4), [], 4), ids(4));
  assert.deepEqual(shownSessionIds(ids(10), [], 3), ["s1", "s2", "s3"]);
});

test("the focused session is always shown and never-focused sessions evict highest ordinal first", () => {
  const recent = focusRecent([], "s7", ids(10));
  assert.deepEqual(shownSessionIds(ids(10), recent, 3), ["s1", "s2", "s7"]);
  assert.deepEqual(shownSessionIds(ids(10), recent, 1), ["s7"]);
});

test("activating a hidden session evicts the least recently focused", () => {
  const all = ids(5);
  let recent = focusRecent([], "s1", all);
  recent = focusRecent(recent, "s2", all);
  recent = focusRecent(recent, "s3", all);
  assert.deepEqual(shownSessionIds(all, recent, 3), ["s1", "s2", "s3"]);
  recent = focusRecent(recent, "s5", all);
  assert.deepEqual(shownSessionIds(all, recent, 3), ["s2", "s3", "s5"]);
});

test("activating a shown session changes focus only", () => {
  const all = ids(4);
  const before = focusRecent(focusRecent([], "s1", all), "s2", all);
  const after = focusRecent(before, "s1", all);
  assert.equal(after[0], "s1");
  assert.deepEqual(shownSessionIds(all, after, 2), shownSessionIds(all, before, 2));
});

test("capacity growth fills by ordinal and shrink keeps the most recently focused", () => {
  const all = ids(6);
  const recent = focusRecent(focusRecent([], "s6", all), "s4", all);
  assert.deepEqual(shownSessionIds(all, recent, 2), ["s4", "s6"]);
  assert.deepEqual(shownSessionIds(all, recent, 4), ["s1", "s2", "s4", "s6"]);
  assert.deepEqual(shownSessionIds(all, recent, 1), ["s4"]);
});

test("a removed or unknown id is ignored without mutating the inputs", () => {
  const all = ids(3);
  const recent = ["s2"];
  assert.equal(focusRecent(recent, "missing", all), recent);
  assert.deepEqual(shownSessionIds(all, ["gone", "s3"], 2), ["s1", "s3"]);
  assert.deepEqual(recent, ["s2"]);
  assert.deepEqual(all, ["s1", "s2", "s3"]);
});

test("a session's turn count is the larger of its summary and its loaded agent turns", () => {
  const agent = (turn: number): GameEvent => ({ id: turn, kind: "agent", text: "", turn });
  assert.equal(sessionTurns(4, []), 4);
  assert.equal(sessionTurns(4, [agent(2), agent(6)]), 6);
  assert.equal(sessionTurns(0, [{ id: 1, kind: "user", text: "go" }]), 0);
});

test("a hidden session's new turns stay unseen until it is shown", () => {
  const sessions = [
    { id: "s1", turns: 2 },
    { id: "s2", turns: 5 },
  ];
  const first = nextSeenTurns({}, sessions, ["s1"]);
  assert.deepEqual(first, { s1: 2, s2: 5 }, "a session first seen starts with nothing unseen");
  const risen = nextSeenTurns(first, [sessions[0], { id: "s2", turns: 7 }], ["s1"]);
  assert.equal(risen.s2, 5, "hidden sessions keep their last seen count");
  assert.equal(nextSeenTurns(risen, [sessions[0], { id: "s2", turns: 7 }], ["s1"]), risen);
  const shown = nextSeenTurns(risen, [sessions[0], { id: "s2", turns: 7 }], ["s1", "s2"]);
  assert.equal(shown.s2, 7);
  assert.deepEqual(risen, { s1: 2, s2: 5 }, "inputs are not mutated");
});

test("chip labels spell out turns, running, caught, focused, shown, hidden and new turns", () => {
  const chip = { running: false, caught: false, shown: true, focused: false, unseen: false };
  assert.equal(
    chipLabel({ ...chip, ordinal: 7, turns: 12, running: true, shown: false, unseen: true }),
    "Session 7, 12 turns, running, hidden, new turns",
  );
  assert.equal(
    chipLabel({ ...chip, ordinal: 1, turns: 4, focused: true }),
    "Session 1, 4 turns, focused",
  );
  assert.equal(
    chipLabel({ ...chip, ordinal: 2, turns: 5, running: true }),
    "Session 2, 5 turns, running, shown",
  );
  assert.equal(chipLabel({ ...chip, ordinal: 3, turns: 1 }), "Session 3, 1 turn, shown");
  assert.equal(
    chipLabel({ ...chip, ordinal: 4, turns: 21, caught: true, focused: true }),
    "Session 4, 21 turns, caught, focused",
  );
});

test("session status uses local work and never shows running after a terminal run", () => {
  assert.equal(sessionIsRunning("active", { busy: false }, { busy: true }), false);
  assert.equal(sessionIsRunning("active", { busy: true }, { busy: false }), true);
  assert.equal(sessionIsRunning("active", undefined, { busy: true }), true);
  assert.equal(sessionIsRunning("caught", { busy: true }, { busy: true }), false);
});

test("chip navigation wraps and supports Home and End", () => {
  assert.equal(nextTabIndex("ArrowRight", 2, 3), 0);
  assert.equal(nextTabIndex("ArrowLeft", 0, 3), 2);
  assert.equal(nextTabIndex("Home", 2, 3), 0);
  assert.equal(nextTabIndex("End", 0, 3), 2);
  assert.equal(nextTabIndex("Enter", 1, 3), null);
});

test("a pane loads each time it becomes shown, and a missing run forgets what was loaded", () => {
  const first = nextShownLoads(new Set(), "run", ["s1", "s2"]);
  assert.deepEqual(first.load, ["s1", "s2"]);
  const again = nextShownLoads(first.loaded, "run", ["s1", "s2"]);
  assert.deepEqual(again.load, [], "still shown: no reload");
  const hidden = nextShownLoads(again.loaded, "run", ["s1"]);
  assert.deepEqual(nextShownLoads(hidden.loaded, "run", ["s1", "s2"]).load, ["s2"]);
  const away = nextShownLoads(again.loaded, null, []);
  assert.equal(away.loaded.size, 0, "leaving the run clears every key");
  assert.deepEqual(nextShownLoads(away.loaded, "run", ["s1", "s2"]).load, ["s1", "s2"]);
  assert.deepEqual(
    nextShownLoads(again.loaded, "other", ["s1"]).load,
    ["s1"],
    "keys are scoped by run",
  );
  assert.equal(first.loaded.has("run:s1"), true);
});

test("a pending session takes the pane its real session will take", () => {
  const all = ids(4);
  let recent = ["s2", "s3", "s4", "s1"].reduce(
    (order, id) => focusRecent(order, id, all),
    [] as string[],
  );
  assert.deepEqual(deckSessions(all, recent, 4, false), all);
  const pending = deckSessions(all, recent, 4, true);
  assert.deepEqual(
    pending,
    ["s1", "s3", "s4", PENDING_SESSION],
    "evicts the least recently focused",
  );
  recent = focusRecent(recent, "s5", [...all, "s5"]);
  const real = deckSessions([...all, "s5"], recent, 4, false);
  assert.deepEqual(real, ["s1", "s3", "s4", "s5"], "the real session lands in the same slot");
  assert.deepEqual(deckSessions(all, recent, 1, true), [PENDING_SESSION], "it is focused");
  assert.deepEqual(deckSessions(ids(1), [], 2, true), ["s1", PENDING_SESSION]);
});

test("the chip strip marks each edge that has chips beyond it", () => {
  assert.deepEqual(stripEdges({ scrollLeft: 0, clientWidth: 300, scrollWidth: 300 }), {
    start: false,
    end: false,
  });
  assert.deepEqual(stripEdges({ scrollLeft: 0, clientWidth: 300, scrollWidth: 500 }), {
    start: false,
    end: true,
  });
  assert.deepEqual(stripEdges({ scrollLeft: 100, clientWidth: 300, scrollWidth: 500 }), {
    start: true,
    end: true,
  });
  assert.deepEqual(
    stripEdges({ scrollLeft: 199.5, clientWidth: 300, scrollWidth: 500 }),
    { start: true, end: false },
    "sub-pixel scroll counts as the end",
  );
});

test("a pending session keeps the pane in use when recent focus was never recorded", () => {
  const all = ids(3);
  // Focus came from the URL, so nothing was recorded; the caller puts it at the head.
  const recent = focusRecent([], "s3", all);
  assert.deepEqual(deckSessions(all, recent, 2, false), ["s1", "s3"]);
  const pending = deckSessions(all, recent, 2, true);
  assert.deepEqual(pending, ["s3", PENDING_SESSION]);
  const after = handOffFocus([], "s3", "s4", [...all, "s4"]);
  assert.deepEqual(after, ["s4", "s3"], "the outgoing focus is recorded before the new one");
  assert.deepEqual(
    deckSessions([...all, "s4"], after, 2, false),
    ["s3", "s4"],
    "the real session takes the placeholder's slot and nothing else moves",
  );
  assert.deepEqual(
    deckSessions([...all, "s4"], focusRecent([], "s4", [...all, "s4"]), 2, false),
    ["s1", "s4"],
    "dropping the outgoing focus is what evicted the pane in use",
  );
});
