import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canCreateNewRun,
  modelLabel,
  refreshedDetailRun,
  refreshedHistoricalGame,
  hasActiveRun,
  lastEventId,
  runStarted,
  selectedNavItem,
  shouldPoll,
  withEarlierEvents,
} from "../app/game-ui";
import type { PublicGame } from "../lib/types";

const game = (overrides: Partial<PublicGame> = {}) =>
  ({
    id: "run",
    status: "active",
    events: [],
    ...overrides,
  }) as PublicGame;

test("navigation selection follows canonical route and whether a detail can continue", () => {
  const continuable = game();
  const cases: [string, PublicGame | null | undefined, string | null][] = [
    ["/play", null, "play"],
    ["/runs", continuable, "history"],
    ["/rank", null, "rank"],
    ["/rules", null, "rules"],
    ["/signin", null, null],
    ["/signin", continuable, null],
    ["/runs/run", continuable, "play"],
    ["/runs/run", { ...continuable, busy: true }, "play"],
    ["/runs/run", undefined, null],
    ["/runs/run", null, null],
    ["/runs/run", { ...continuable, status: "ended" }, null],
    ["/runs/run", { ...continuable, status: "captured" }, null],
    ["/runs/run", { ...continuable, status: "exhausted" }, null],
    ["/runs/run", { ...continuable, status: "creating" }, null],
    ["/runs/run", { ...continuable, status: "blocked" }, null],
  ];
  for (const [path, detail, expected] of cases)
    assert.equal(selectedNavItem(path, detail), expected, `${path} with ${detail?.status}`);
});

test("history model labels preserve the mixed-model sentinel", () => {
  assert.equal(modelLabel(null), "Mixed models");
  assert.equal(modelLabel("provider/model"), "model");
});

test("a run has started once it has a recorded instruction", () => {
  assert.equal(runStarted(game()), false);
  assert.equal(runStarted(game({ events: [{ id: 3, kind: "agent", text: "hi" }] })), false);
  assert.equal(runStarted(game({ events: [{ id: -1, kind: "user", text: "optimistic" }] })), false);
  assert.equal(runStarted(game({ events: [{ id: 1, kind: "user", text: "go" }] })), true);
});

test("an empty current run cannot be replaced, but a used or ended run can", () => {
  assert.equal(canCreateNewRun(undefined, false), false);
  assert.equal(canCreateNewRun(null), true);
  assert.equal(canCreateNewRun(game()), false);
  assert.equal(canCreateNewRun(game(), true), false);
  assert.equal(
    canCreateNewRun(game({ events: [{ id: 1, kind: "user", text: "go" }] }), true),
    true,
  );
  assert.equal(
    canCreateNewRun(game({ events: [{ id: 1, kind: "user", text: "go" }], busy: true }), true),
    false,
    "a run with any busy session cannot be replaced",
  );
  assert.equal(
    canCreateNewRun(game({ events: [{ id: -1, kind: "user", text: "optimistic" }] })),
    false,
  );
  for (const status of ["ended", "captured", "exhausted", "blocked"] as const)
    assert.equal(canCreateNewRun(game({ status })), true, status);
  assert.equal(canCreateNewRun(game({ status: "finalizing", monitorMode: "legacy" })), false);
  assert.equal(canCreateNewRun(game({ status: "finalizing", monitorMode: "async" })), true);
});

test("polling follows live work, not pending billing", () => {
  // A run whose billing hold never settles must not be re-fetched forever.
  assert.equal(shouldPoll(game({ reservedMicrodollars: 36518 }), false, false), false);
  assert.equal(
    shouldPoll(game({ reservedMicrodollars: 36518, status: "ended" }), false, false),
    false,
  );
  assert.equal(shouldPoll(game({ busy: true }), false, false), true);
  assert.equal(shouldPoll(game({ status: "finalizing" }), false, false), true);
  assert.equal(shouldPoll(game(), false, true), true);
  // The prompt stream already delivers updates while this tab drives the turn.
  assert.equal(shouldPoll(game({ busy: true }), true, true), false);
  const asyncRun = game({ monitorMode: "async" });
  assert.equal(
    shouldPoll(asyncRun, true, false),
    true,
    "reviews can finish during a prompt stream",
  );
  assert.equal(shouldPoll(asyncRun, false, false), true, "late review can catch an idle run");
  assert.equal(
    shouldPoll(game({ monitorMode: "async", status: "finalizing" }), true, false),
    true,
    "finalizing remains pending while the prompt stream closes",
  );
  assert.equal(shouldPoll(game({ monitorMode: "async", status: "caught" }), false, false), false);
});

test("ended async runs keep polling for review debt and stop after catch or unresolved review", () => {
  const pending = (status: "queued" | "reviewing") =>
    game({
      monitorMode: "async",
      status: "ended",
      monitor: {
        status,
        pendingSessions: 1,
        reviewedUpdates: 0,
        totalUpdates: 1,
        lastReviewedAt: null,
        hasPendingReview: true,
      },
    });
  for (const status of ["queued", "reviewing"] as const) {
    assert.equal(shouldPoll(pending(status), false, false), true, `${status} ended run`);
    assert.equal(
      shouldPoll({ ...pending(status), status: "exhausted" }, false, false),
      true,
      `${status} exhausted run`,
    );
  }
  const caught = { ...pending("reviewing"), status: "caught" as const };
  assert.equal(shouldPoll(caught, false, false), false);
  assert.equal(
    shouldPoll(
      {
        ...pending("queued"),
        monitor: { ...pending("queued").monitor!, status: "unresolved", hasPendingReview: false },
      },
      false,
      false,
    ),
    false,
  );
  assert.equal(
    shouldPoll(
      {
        ...pending("queued"),
        monitor: { ...pending("queued").monitor!, status: "unresolved", hasPendingReview: true },
      },
      false,
      false,
    ),
    true,
    "unresolved sibling cannot hide runnable review debt",
  );
  assert.equal(
    shouldPoll(
      {
        ...pending("queued"),
        monitor: { ...pending("queued").monitor!, status: "caught-up", hasPendingReview: false },
      },
      false,
      false,
    ),
    false,
  );
  assert.equal(shouldPoll(game({ monitorMode: "legacy", status: "ended" }), false, false), false);
  assert.equal(
    shouldPoll(game({ monitorMode: "async", status: "ended", monitor: undefined }), false, false),
    false,
  );
});

test("a late historical poll cannot replace another run or selected session", () => {
  const pending = game({
    id: "older",
    sessionId: "session-a",
    status: "ended",
    stateRevision: "2",
  });
  const caught = { ...pending, status: "caught" as const, stateRevision: "3" };
  assert.equal(refreshedHistoricalGame(pending, caught, "older", "session-a")?.status, "caught");
  const switchedRun = { ...pending, id: "newer" };
  assert.equal(refreshedHistoricalGame(switchedRun, caught, "older", "session-a"), switchedRun);
  const switchedSession = { ...pending, sessionId: "session-b" };
  assert.equal(
    refreshedHistoricalGame(switchedSession, caught, "older", "session-a"),
    switchedSession,
  );
  assert.equal(refreshedHistoricalGame(caught, pending, "older", "session-a"), caught);
});

test("delta polls keep held events and append only newer ones", () => {
  const held = [
    { id: 4, kind: "user" as const, text: "go" },
    { id: 7, kind: "agent" as const, text: "thinking" },
    { id: -1, kind: "user" as const, text: "optimistic" },
  ];
  assert.equal(lastEventId(held), 7);
  assert.equal(lastEventId([]), 0);
  const delta = game({ events: [{ id: 9, kind: "tool", text: "ok" }], turns: 2 });
  const merged = withEarlierEvents(held, delta, 7);
  assert.deepEqual(
    merged.events.map((event) => event.id),
    [4, 7, 9],
  );
  assert.equal(merged.turns, 2, "run fields come from the fresh response");
});

test("Play opens the new-run dialog unless a run can still be continued", () => {
  assert.equal(hasActiveRun(null), false);
  assert.equal(hasActiveRun(undefined), false);
  assert.equal(hasActiveRun(game()), true);
  for (const status of ["captured", "exhausted", "ended", "creating"] as const)
    assert.equal(hasActiveRun(game({ status })), false, status);
});

test("a My Runs poll of another shown session still updates the run but keeps its session", () => {
  const current = game({
    status: "finalizing",
    sessionId: "s1",
    stateRevision: "5",
    spentMicrodollars: 100,
    monitor: { status: "reviewing" } as PublicGame["monitor"],
    events: [{ id: 1, kind: "user", text: "s1 instruction" }],
    sessions: [],
  });
  const sibling = game({
    status: "caught",
    sessionId: "s2",
    stateRevision: "6",
    spentMicrodollars: 250,
    monitor: { status: "caught" } as PublicGame["monitor"],
    events: [{ id: 2, kind: "user", text: "s2 instruction" }],
    sessions: [],
  });
  const next = refreshedDetailRun(current, sibling, "run", "s2")!;
  assert.equal(next.status, "caught");
  assert.equal(next.spentMicrodollars, 250);
  assert.equal(next.monitor?.status, "caught");
  assert.equal(next.sessionId, "s1", "focus is not moved by a sibling poll");
  assert.deepEqual(next.events, current.events);

  const own = refreshedDetailRun(current, { ...sibling, sessionId: "s1" }, "run", "s1")!;
  assert.equal(own.status, "caught");
  assert.deepEqual(own.events, sibling.events, "the run's own session replaces its events");

  assert.equal(
    refreshedDetailRun(current, { ...sibling, stateRevision: "4" }, "run", "s2"),
    current,
  );
  assert.equal(refreshedDetailRun(current, { ...sibling, id: "other" }, "run", "s2"), current);
});
