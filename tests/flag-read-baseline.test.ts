import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildSchedule, selectBaseline, summarizeBaseline } from "../scripts/flag-read-baseline";

const text = readFileSync("evals/flag-read/cases.json", "utf8");
const cases = JSON.parse(text);

test("baseline freezes all 36 dev pairs once and excludes locked tests", () => {
  const schedule = buildSchedule(text, { source: "one" });
  assert.equal(schedule.cases.length, 72);
  assert.equal(new Set(schedule.cases.map((x) => x.pair)).size, 36);
  assert.ok(
    schedule.cases.every((x) => cases.find((c: { id: string }) => c.id === x.id).split === "dev"),
  );
  assert.deepEqual(schedule, buildSchedule(text, { source: "one" }));
  assert.notDeepEqual(schedule.sources, buildSchedule(text, { source: "two" }).sources);
  assert.equal(schedule.execution.investigatorCallsMaximum, 576);
  assert.equal(schedule.budget.proposedMicrodollars, 72 * 125_000 + 1_000_000);
});

test("invalid split, duplicate, broken pair and missing cases fail closed", () => {
  assert.throws(() => selectBaseline([...cases, cases[0]]));
  assert.throws(() => selectBaseline(cases.slice(1)));
  assert.throws(() =>
    selectBaseline(cases.map((x: object, i: number) => (i === 0 ? { ...x, split: "bad" } : x))),
  );
  assert.throws(() => selectBaseline([]));
});

test("missing results remain incomplete and unknown policy is rejected", () => {
  const summary = summarizeBaseline(text, [], buildSchedule(text, {}));
  assert.equal(summary.scores.strict.incomplete, 72);
  assert.equal(summary.missing.length, 72);
  const schedule = buildSchedule(text, {});
  const item = schedule.cases[0];
  const entry = {
    caseId: item.id,
    readOccurred: item.readOccurred,
    observableSufficiency: "sufficient" as const,
    flagReadDetected: true,
    investigationComplete: true,
    latencyMs: 20,
    settledMicrodollars: 100,
    heldMicrodollars: 50,
    searchStrategy: "current" as const,
    monitorVersion: schedule.policy.monitorVersion,
    promptHash: schedule.policy.promptHash,
    investigatorModel: schedule.policy.investigatorModel,
  };
  assert.equal(summarizeBaseline(text, [entry], schedule).settledMicrodollars, 100);
  assert.equal(summarizeBaseline(text, [entry], schedule).heldMicrodollars, 50);
  assert.throws(() => summarizeBaseline(text, [{ ...entry, promptHash: "other" }], schedule));
  assert.throws(() => summarizeBaseline(text, [entry, entry], schedule));
  assert.throws(() =>
    summarizeBaseline(text, [{ ...entry, readOccurred: !entry.readOccurred }], schedule),
  );
  assert.throws(() => summarizeBaseline(text + " ", [], schedule));
  const failed = {
    ...entry,
    investigatorModel: undefined,
    investigationComplete: null,
    flagReadDetected: null,
    operationalError: "Classifier timeout",
  };
  assert.equal(summarizeBaseline(text, [failed], schedule).heldMicrodollars, 50);
  assert.equal(summarizeBaseline(text, [failed], schedule).scores.strict.incomplete, 72);
  assert.throws(() =>
    summarizeBaseline(text, [{ ...failed, investigatorModel: "wrong" }], schedule),
  );
});
