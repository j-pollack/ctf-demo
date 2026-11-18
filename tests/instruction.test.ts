import { test } from "node:test";
import assert from "node:assert/strict";
import { canEditRun, refreshedGame } from "../app/game-ui";
import type { PublicGame } from "../lib/types";

const current = {
  id: "run",
  busy: false,
  events: [{ id: 10, kind: "user", text: "Try again" }],
} as PublicGame;
const pending = { gameId: "run", text: "Try again", afterId: 10 };

test("busy recovery retains the submitted entry until a NEW matching user event arrives", () => {
  const busy = { ...current, busy: true };
  // The runtime refresh must not drop an instruction whose acceptance is still uncertain.
  const next = refreshedGame(current, busy, pending);
  assert.equal(next?.events.filter((event) => event.kind === "user").length, 2);
  assert.equal(next?.events.at(-1)?.text, pending.text);
});

test("a repeated instruction is accepted only by a new matching USER event", async () => {
  const { instructionStatus } = await import("../app/game-ui");
  assert.equal(instructionStatus(pending, { ...current, busy: true }), "pending");
  assert.equal(instructionStatus(pending, current), "rejected");
  for (const busy of [false, true]) {
    const accepted = {
      ...current,
      busy,
      events: [...current.events, { id: 11, kind: "user" as const, text: pending.text }],
    };
    assert.equal(instructionStatus(pending, accepted), "accepted");
    assert.equal(refreshedGame(current, accepted, pending), accepted);
    assert.equal(accepted.events.filter((event) => event.kind === "user").length, 2);
  }
  const unrelated = {
    ...current,
    busy: true,
    events: [...current.events, { id: 11, kind: "agent" as const, text: pending.text }],
  };
  assert.equal(instructionStatus(pending, unrelated), "pending");
  assert.equal(instructionStatus(pending, { ...unrelated, busy: false }), "rejected");
});

test("done before user and settled interrupted recovery reject; busy or unavailable recovery stays uncertain", async () => {
  const { instructionStatus } = await import("../app/game-ui");
  assert.equal(instructionStatus(pending), "pending");
  assert.equal(instructionStatus(pending, { ...current, id: "other" }), "pending");
  assert.equal(refreshedGame(current, { ...current, id: "other" }, pending), current);
  const optimistic = refreshedGame(current, { ...current, busy: true }, pending)!;
  assert.equal(optimistic.events.filter((event) => event.id === -1).length, 1);
  assert.equal(
    refreshedGame(optimistic, optimistic, pending)?.events.filter((event) => event.id === -1)
      .length,
    1,
  );
  const failedSetup = {
    ...current,
    events: [...current.events, { id: 11, kind: "error" as const, text: "Setup failed" }],
  };
  assert.equal(instructionStatus(pending, failedSetup), "rejected");
  assert.equal(
    refreshedGame(optimistic, failedSetup, pending)?.events.some((event) => event.id === -1),
    false,
  );
});

test("pending recovery cannot inject the previous run's instruction into another run", () => {
  const other = { ...current, id: "other", busy: true };
  assert.equal(refreshedGame(other, other, pending), other);
});

test("a delayed same-run snapshot cannot erase an accepted newer submission after pending clears", () => {
  const accepted = {
    ...current,
    events: [...current.events, { id: 11, kind: "user" as const, text: "New submission" }],
  };
  const stale = { ...current, busy: false };
  assert.equal(refreshedGame(accepted, stale, null, 1, 2), accepted);
  assert.equal(refreshedGame(accepted, accepted, null, 2, 2), accepted);
});

test("a delayed same-run snapshot cannot reject or erase a newer optimistic submission", () => {
  const nextPending = { gameId: "run", text: "New submission", afterId: 10 };
  const optimistic = {
    ...current,
    events: [...current.events, { id: -1, kind: "user" as const, text: nextPending.text }],
  };
  assert.equal(refreshedGame(optimistic, current, nextPending, 1, 2), optimistic);
});

test("an older async progress snapshot cannot rewind review or reopen submitted play", () => {
  const ahead = {
    ...current,
    status: "finalizing" as const,
    monitorMode: "async" as const,
    stateRevision: "12",
    monitor: {
      status: "reviewing" as const,
      pendingSessions: 1,
      reviewedUpdates: 2,
      totalUpdates: 3,
      lastReviewedAt: "2026-11-10T00:00:00.000Z",
    },
  };
  const behind = {
    ...ahead,
    status: "active" as const,
    stateRevision: "11",
    monitor: { ...ahead.monitor, status: "queued" as const, reviewedUpdates: 1 },
  };
  assert.equal(refreshedGame(ahead, behind), ahead);
  assert.equal(refreshedGame(ahead, { ...ahead, stateRevision: "13" })?.stateRevision, "13");
});

test("a held stale session fetch cannot reopen a caught run or enable the composer", async () => {
  const active = { ...current, status: "active" } as PublicGame;
  for (const staleStatus of ["active", "finalizing", "creating"] as const) {
    let state = active;
    let release!: (snapshot: PublicGame) => void;
    const response = new Promise<PublicGame>((resolve) => (release = resolve));
    const applying = response.then((snapshot) => {
      state = refreshedGame(state, snapshot) ?? state;
    });

    state = {
      ...state,
      status: "caught",
      busy: false,
      sessionBusy: false,
      caughtSessionId: "session-a",
      caughtSessionOrdinal: 2,
      caughtReason: "The investigator found the prepared flag read.",
      turns: 1,
      tokensUsed: 12,
      blocks: 1,
      spentMicrodollars: 31,
      reservedMicrodollars: 0,
      agentSpendMicrodollars: 27,
      monitorSpendMicrodollars: 4,
    };
    release({
      ...active,
      status: staleStatus,
      busy: true,
      sessionBusy: true,
      caughtSessionId: null,
      caughtSessionOrdinal: null,
      caughtReason: null,
      turns: 0,
      tokensUsed: 0,
      blocks: 0,
      spentMicrodollars: 0,
      reservedMicrodollars: 9,
      agentSpendMicrodollars: 0,
      monitorSpendMicrodollars: 0,
    });
    await applying;

    assert.equal(state.status, "caught", `stale ${staleStatus} snapshot`);
    assert.equal(canEditRun(state.status, true), false, `composer after stale ${staleStatus}`);
    assert.equal(state.caughtSessionId, "session-a");
    assert.equal(state.caughtSessionOrdinal, 2);
    assert.equal(state.caughtReason, "The investigator found the prepared flag read.");
    assert.equal(state.busy, false);
    assert.equal(state.sessionBusy, false);
    assert.equal(state.turns, 1);
    assert.equal(state.tokensUsed, 12);
    assert.equal(state.blocks, 1);
    assert.equal(state.spentMicrodollars, 31);
    assert.equal(state.reservedMicrodollars, 0);
    assert.equal(state.agentSpendMicrodollars, 27);
    assert.equal(state.monitorSpendMicrodollars, 4);
  }
  assert.equal(
    refreshedGame({ ...active, status: "finalizing" }, active)?.status,
    "active",
    "an authoritative active fetch can recover a failed finalization",
  );
});
