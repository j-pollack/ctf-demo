import assert from "node:assert/strict";
import test from "node:test";
import * as UI from "../app/game-ui";

const { shouldAutoContinue } = UI;
import type { GameEvent, PublicGame } from "../lib/types";

const stopped: GameEvent = {
  id: 2,
  kind: "error",
  text: "Response stopped.",
  resumable: true,
  autoContinue: true,
};
const MAX = 8;
const run = (events: GameEvent[], status = "active") =>
  ({ status, events }) as unknown as PublicGame;

test("auto-continue only follows a time-limited stop on an active run under the cap", () => {
  const user: GameEvent = { id: 1, kind: "user", text: "go" };
  assert.equal(shouldAutoContinue(run([user, stopped]), 0, MAX), true);
  assert.equal(shouldAutoContinue(run([user, stopped]), MAX - 1, MAX), true);
  assert.equal(shouldAutoContinue(run([user, stopped]), MAX, MAX), false);
  assert.equal(shouldAutoContinue(run([user, stopped]), 2, 2), false);
  for (const status of ["captured", "caught", "exhausted"])
    assert.equal(shouldAutoContinue(run([user, stopped], status), 0, MAX), false, status);
  // A manual Stop remains resumable but has no autoContinue signal, including after reload.
  assert.equal(
    shouldAutoContinue(run([user, { ...stopped, autoContinue: undefined }]), 0, MAX),
    false,
  );
  // A genuine failure (not resumable), or a newer event after the stop, ends the chain.
  assert.equal(
    shouldAutoContinue(run([user, { ...stopped, resumable: undefined }]), 0, MAX),
    false,
  );
  assert.equal(shouldAutoContinue(run([stopped, user]), 0, MAX), false);
  assert.equal(shouldAutoContinue(run([]), 0, MAX), false);
  assert.equal(shouldAutoContinue(null, 0, MAX), false);
});

test("the stored maximum decides, zero turns disables it, and a failed send stops the chain", () => {
  const user: GameEvent = { id: 1, kind: "user", text: "go" };
  const game = run([user, stopped]);
  assert.equal(shouldAutoContinue(game, 0, 0), false, "zero disables auto-continue");
  assert.equal(shouldAutoContinue(game, 0, 1), true);
  assert.equal(shouldAutoContinue(game, 1, 1), false);
  assert.equal(shouldAutoContinue(game, 49, 50), true);
  assert.equal(shouldAutoContinue(game, 50, 50), false);
  // The counter set after a failed send is Infinity, which no stored maximum can reach.
  assert.equal(shouldAutoContinue(game, Infinity, 50), false);
});
