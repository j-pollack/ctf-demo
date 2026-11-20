import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolveFlagReadPolicy } from "../lib/flag-read-policy";
import {
  buildSchedule,
  parseBaselineStrategy,
  selectBaseline,
  summarizeBaseline,
} from "../scripts/flag-read-baseline";
import { syntheticHeldoutCorpus } from "./fixtures/heldout-corpus";

const text = readFileSync("evals/flag-read/cases.json", "utf8");
const cases = JSON.parse(text);

test("explicit held-out selection freezes 40 cases and scores only that split", () => {
  const corpus = syntheticHeldoutCorpus(text);
  const items = JSON.parse(corpus);
  const schedule = buildSchedule(corpus, {}, "closed-world-presumption", "test");
  assert.equal(schedule.split, "test");
  assert.equal(schedule.cases.length, 40);
  assert.equal(new Set(schedule.cases.map((item) => item.pair)).size, 20);
  assert.ok(schedule.cases.every((item) => item.id.startsWith("test-")));
  assert.deepEqual(
    selectBaseline(items, "test").map((item) => item.id),
    schedule.cases.map((item) => item.id),
  );
  assert.equal(selectBaseline(items).length, 72);
  assert.equal(schedule.execution.cases, 40);
  assert.equal(schedule.execution.investigatorCallsMaximum, 480);
  assert.equal(schedule.execution.classifierCallsMaximum, 40);
  assert.equal(schedule.budget.proposedMicrodollars, 6_000_000);
  assert.match(schedule.budget.basis, /40 ×.*\$6.*480 calls/);
  assert.throws(() => selectBaseline(items, "other" as "test"), /split/i);
  assert.throws(() => selectBaseline(items.slice(0, -2), "test"));
  const empty = summarizeBaseline(corpus, [], schedule);
  assert.equal(empty.missing.length, 40);
  assert.equal(empty.scores.presumption.incomplete, 40);
  const entries = schedule.cases.map((item) => ({
    caseId: item.id,
    readOccurred: item.readOccurred,
    observableSufficiency: "sufficient" as const,
    flagReadDetected: item.presumption === "read",
    investigationComplete: true,
    latencyMs: 1,
    settledMicrodollars: 1,
    heldMicrodollars: 0,
    searchStrategy: "closed-world-presumption" as const,
    ...schedule.policy,
  }));
  const summary = summarizeBaseline(corpus, entries, schedule);
  assert.equal(
    summary.scores.presumption.labelPositiveDetected,
    schedule.cases.filter((x) => x.presumption === "read").length,
  );
  assert.equal(summary.scores.presumption.unsupportedFindings, 0);
  assert.equal(
    summary.scores.strict.unsupportedFindings,
    schedule.cases.filter((x) => x.presumption === "read" && x.strict !== "read").length,
  );
  assert.equal(summary.settledMicrodollars, 40);
  assert.deepEqual(summary.missing, []);
  assert.equal(
    Object.values(summary.perFamily).reduce((n, family) => n + family.presumption.labelPositive, 0),
    summary.scores.presumption.labelPositive,
  );
  assert.throws(() => summarizeBaseline(corpus, [entries[0], entries[0]], schedule), /duplicate/);
  assert.throws(
    () =>
      summarizeBaseline(corpus, [{ ...entries[0], caseId: selectBaseline(items)[0].id }], schedule),
    /Unknown/,
  );
});

test("bounded schedules freeze DigitalOcean pricing and the 90-second investigation", () => {
  const schedule = buildSchedule(text, {});
  assert.equal(schedule.execution.investigatorDeadlineMs, 90_000);
  assert.equal(schedule.execution.classifierDeadlineMs, 15_000);
  assert.equal(schedule.execution.reviewClaimMs, 120_000);
  assert.deepEqual(schedule.execution.provider, {
    only: ["digitalocean"],
    allow_fallbacks: false,
    require_parameters: true,
    max_price: { prompt: 0.91, completion: 2.86, request: 0 },
  });
  assert.equal(schedule.budget.pricing.investigator.inputUsdPerMillion, 0.91);
  assert.equal(schedule.budget.pricing.investigator.outputUsdPerMillion, 2.86);
});

test("the production strategy is the default, records the production policy and its summaries enforce the saved prompt hash", () => {
  assert.equal(parseBaselineStrategy("closed-world-presumption"), "closed-world-presumption");
  assert.throws(() => parseBaselineStrategy("focused"), /strategy/);
  assert.throws(() => buildSchedule(text, {}, "focused" as "closed-world-presumption"), /strategy/);
  const production = resolveFlagReadPolicy("closed-world-presumption");
  const schedule = buildSchedule(text, { source: "same" }, "closed-world-presumption");
  assert.deepEqual(schedule, buildSchedule(text, { source: "same" }));
  assert.equal(schedule.policy.strategy, "closed-world-presumption");
  assert.equal(schedule.policy.monitorVersion, production.monitorVersion);
  assert.equal(schedule.policy.promptHash, production.promptHash);
  const entry = {
    caseId: schedule.cases[0].id,
    readOccurred: schedule.cases[0].readOccurred,
    observableSufficiency: "sufficient" as const,
    flagReadDetected: false,
    investigationComplete: true,
    latencyMs: 10,
    settledMicrodollars: 12,
    heldMicrodollars: 0,
    searchStrategy: "closed-world-presumption" as const,
    ...schedule.policy,
  };
  assert.equal(summarizeBaseline(text, [entry], schedule).settledMicrodollars, 12);
  assert.throws(
    () => summarizeBaseline(text, [{ ...entry, promptHash: "changed" }], schedule),
    /policy\/model/,
  );
});

test("baseline freezes all 36 dev pairs once and excludes locked tests", () => {
  const schedule = buildSchedule(text, { source: "one" });
  assert.equal(schedule.cases.length, 72);
  assert.equal(new Set(schedule.cases.map((x) => x.pair)).size, 36);
  assert.ok(
    schedule.cases.every((x) => cases.find((c: { id: string }) => c.id === x.id).split === "dev"),
  );
  assert.deepEqual(schedule, buildSchedule(text, { source: "one" }));
  assert.notDeepEqual(schedule.sources, buildSchedule(text, { source: "two" }).sources);
  assert.equal(schedule.execution.investigatorCallsMaximum, 864);
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
    searchStrategy: "closed-world-presumption" as const,
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
