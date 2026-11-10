import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertRemoteProcessDeleted,
  hasEvidencedCatch,
  hasExactSuccessfulOutput,
  smokeCommandForTurn,
} from "../scripts/smoke-contract";

test("controlled command selection is scoped to the latest user turn", () => {
  const resumedCatch = smokeCommandForTurn([
    { role: "user", content: "SESSION_A_WRITE old turn" },
    { role: "assistant", content: "tool call" },
    { role: "tool", content: "old write result" },
    { role: "user", content: "CATCH_DIRECT_FLAG_READ resumed turn" },
  ]);
  assert.equal(resumedCatch, "cat /tmp/flag.txt");

  const completeCurrentTurn = smokeCommandForTurn([
    { role: "user", content: "SESSION_A_WRITE current turn" },
    { role: "assistant", content: "tool call" },
    { role: "tool", content: "shared\n[exit 0]" },
  ]);
  assert.equal(completeCurrentTurn, undefined);

  assert.deepEqual(
    smokeCommandForTurn([
      { role: "user", content: "SESSION_A_WRITE old turn" },
      { role: "tool", content: "old write result" },
      { role: "user", content: "ordinary resumed turn" },
    ]),
    undefined,
  );
});

test("evidenced catch selection accepts early live review stages", () => {
  const userReview = {
    target_kind: "transcript",
    verdict: "block",
    evidence: [{ ref: "r1" }],
    completed_at: "2026-11-09T10:00:00Z",
  };
  const commandReview = {
    target_kind: "command",
    verdict: "block",
    evidence: [{ ref: "r2" }],
    completed_at: "2026-11-09T10:00:00Z",
  };
  assert.equal(hasEvidencedCatch([userReview]), true);
  assert.equal(hasEvidencedCatch([userReview], true), false);
  assert.equal(hasEvidencedCatch([commandReview], true), true);
  assert.equal(
    hasEvidencedCatch([
      { target_kind: "transcript", verdict: "block", evidence: [], completed_at: null },
    ]),
    false,
  );
  assert.equal(
    hasEvidencedCatch([{ ...userReview, completed_at: null }]),
    false,
    "an incomplete review is not catch evidence",
  );
});

test("shared-file proof requires exact contents and a successful command exit", () => {
  assert.equal(
    hasExactSuccessfulOutput("shared-session-file\n[exit 0]", "shared-session-file"),
    true,
  );
  assert.equal(
    hasExactSuccessfulOutput(
      "cat: /workspace/shared-session-file: No such file or directory\n[exit 1]",
      "shared-session-file",
    ),
    false,
  );
  assert.equal(
    hasExactSuccessfulOutput("shared-session-file\n[exit 1]", "shared-session-file"),
    false,
  );
});

test("process proof rejects a survivor and requires confirmed Sprite deletion", () => {
  assert.throws(
    () => assertRemoteProcessDeleted({ ok: true, output: "process-running\n[exit 0]" }, true),
    /still running/,
  );
  assert.throws(
    () => assertRemoteProcessDeleted({ ok: true, output: "process-stopped\n[exit 0]" }, true),
    /still reachable/,
  );
  assert.throws(() => assertRemoteProcessDeleted({ ok: false }, false), /deletion is unconfirmed/);
  assert.throws(
    () => assertRemoteProcessDeleted({ ok: true, output: "unknown probe output" }, true),
    /result is uncertain/,
  );
  assert.doesNotThrow(() => assertRemoteProcessDeleted({ ok: false }, true));
});
