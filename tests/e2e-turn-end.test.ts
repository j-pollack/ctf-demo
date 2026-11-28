import assert from "node:assert/strict";
import { test } from "node:test";
import { turnEnd } from "./e2e/turn-end";

const open = { status: "active", leased: false };

test("a run that is no longer open is over, whatever its events hold", () => {
  assert.deepEqual(turnEnd({ status: "exhausted", leased: true, events: [] }), {
    kind: "over",
    text: "exhausted",
  });
});

test("a live lease or no event yet is not an end", () => {
  assert.equal(
    turnEnd({ ...open, leased: true, events: [{ kind: "agent", text: "hi" }] }),
    undefined,
  );
  assert.equal(turnEnd({ ...open, events: [] }), undefined);
});

test("a reply or an error ends the turn", () => {
  assert.deepEqual(turnEnd({ ...open, events: [{ kind: "agent", text: "no" }] }), {
    kind: "reply",
    text: "no",
  });
  assert.deepEqual(turnEnd({ ...open, events: [{ kind: "error", text: "boom" }] }), {
    kind: "error",
    text: "boom",
  });
});

test("an error marked for automatic continue is not an end, nor is the continue's own turn", () => {
  const stopped = { kind: "error", text: "Response stopped.", resumable: true, autoContinue: true };
  assert.equal(turnEnd({ ...open, events: [stopped] }), undefined);
  assert.equal(
    turnEnd({ ...open, events: [stopped, { kind: "user", text: "Continue." }] }),
    undefined,
  );
  assert.equal(
    turnEnd({ ...open, events: [{ ...stopped, autoContinue: undefined }] })?.kind,
    "error",
    "a manual stop is an end",
  );
});
