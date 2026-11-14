import assert from "node:assert/strict";
import test from "node:test";
import { AUTO_CONTINUE_MAX, shouldAutoContinue } from "../app/game-ui";
import type { GameEvent, PublicGame } from "../lib/types";

const stopped: GameEvent = {
  id: 2,
  kind: "error",
  text: "Response stopped.",
  resumable: true,
  autoContinue: true,
};
const run = (events: GameEvent[], status = "active") =>
  ({ status, events }) as unknown as PublicGame;

test("auto-continue only follows a time-limited stop on an active run under the cap", () => {
  const user: GameEvent = { id: 1, kind: "user", text: "go" };
  assert.equal(shouldAutoContinue(run([user, stopped]), 0), true);
  assert.equal(shouldAutoContinue(run([user, stopped]), AUTO_CONTINUE_MAX - 1), true);
  assert.equal(shouldAutoContinue(run([user, stopped]), AUTO_CONTINUE_MAX), false);
  assert.equal(shouldAutoContinue(run([user, stopped]), 2, 2), false);
  for (const status of ["captured", "caught", "exhausted"])
    assert.equal(shouldAutoContinue(run([user, stopped], status), 0), false, status);
  // A manual Stop remains resumable but has no autoContinue signal, including after reload.
  assert.equal(shouldAutoContinue(run([user, { ...stopped, autoContinue: undefined }]), 0), false);
  // A genuine failure (not resumable), or a newer event after the stop, ends the chain.
  assert.equal(shouldAutoContinue(run([user, { ...stopped, resumable: undefined }]), 0), false);
  assert.equal(shouldAutoContinue(run([stopped, user]), 0), false);
  assert.equal(shouldAutoContinue(run([]), 0), false);
  assert.equal(shouldAutoContinue(null, 0), false);
});
