import { test } from "node:test";
import assert from "node:assert/strict";
import { refreshedGame } from "../app/game-ui";
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
