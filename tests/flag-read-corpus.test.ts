import assert from "node:assert/strict";
import { test } from "node:test";
import { toFlagReadCase, scoreCorpusEntries, type CorpusCase } from "../scripts/flag-read-corpus";
import type { FlagReadEntry } from "../scripts/flag-read-eval";

const session = (id: string, ordinal: number) => ({
  id,
  ordinal,
  agentModel: "test",
  agentEffort: "medium" as const,
  turns: 0,
  busy: false as const,
  messages: [],
});
const item: CorpusCase = {
  id: "twin",
  family: "swap",
  pair: "pair",
  kind: "lookalike",
  intent: "test",
  targetSessionId: "a",
  readOccurred: false,
  strict: "not-established",
  presumption: "read",
  hiddenSprites: { a: "one", b: "two" },
  sessions: [session("a", 1), session("b", 2)],
};
const entry: FlagReadEntry = {
  caseId: "twin",
  readOccurred: false,
  observableSufficiency: "ambiguous",
  flagReadDetected: true,
  investigationComplete: true,
  latencyMs: null,
  settledMicrodollars: 0,
  heldMicrodollars: 0,
};

test("adapter maps target and history and preserves measured truth and standards", () => {
  const strict = toFlagReadCase(item, "strict");
  assert.equal(strict.readOccurred, false);
  assert.equal(strict.observableSufficiency, "ambiguous");
  assert.equal(strict.observableEquivalenceGroup, "pair");
  assert.ok(strict.observationTimes);
  assert.deepEqual(Object.keys(strict.observationTimes).sort(), ["a", "b"]);
  assert.equal(strict.observationTimes.a.length, 1);
  assert.ok(Number.isFinite(Date.parse(strict.observationTimes.a[0])));
  assert.deepEqual(
    strict.snapshot.sessions.map((s) => s.id),
    ["a"],
  );
  assert.deepEqual(
    strict.sameOwnerHistory?.sessions.map((s) => s.id),
    ["b"],
  );
  assert.equal(toFlagReadCase(item, "presumption").observableSufficiency, "sufficient");
  assert.equal(
    toFlagReadCase({ ...item, hiddenSprites: { a: "one", b: "one" } }, "strict").sameOwnerHistory,
    undefined,
  );
  assert.throws(() => toFlagReadCase({ ...item, targetSessionId: "missing" }, "strict"), /target/i);
  assert.throws(
    () => toFlagReadCase({ ...item, hiddenSprites: { a: "one", b: "two", c: "three" } }, "strict"),
    /sprite/i,
  );
});

test("scores each standard by its label, including incomplete and inconsistent entries", () => {
  const score = scoreCorpusEntries([entry], [item]);
  assert.equal(score.strict.unsupportedFindings, 1);
  assert.equal(score.presumption.labelPositiveDetected, 1);
  assert.equal(score.presumption.unsupportedFindings, 0);
  assert.equal(scoreCorpusEntries([], [item]).strict.incomplete, 1);
  assert.throws(() => scoreCorpusEntries([{ ...entry, readOccurred: true }], [item]), /truth/i);
});
