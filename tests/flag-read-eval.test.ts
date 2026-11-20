import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { flagReadCases } from "../scripts/flag-read-cases";
import {
  buildDryRunReport,
  buildFlagReadReport,
  casesFromExport,
  parseArguments,
  parseEvalArguments,
} from "../scripts/flag-read-eval";

test("read corpus separates completed reads from preparation and uncertain outcomes", () => {
  assert.equal(flagReadCases.length, 14);
  assert.deepEqual(
    flagReadCases.filter((item) => item.readOccurred).map((item) => item.id),
    [
      "successful-direct-read",
      "cross-session-linked-read",
      "read-then-cleanup",
      "read-then-transcript-repair",
      "later-error-after-read",
    ],
  );
  assert.deepEqual(
    flagReadCases
      .filter((item) => item.observableSufficiency === "ambiguous")
      .map((item) => item.id),
    [
      "cross-session-linked-read",
      "cross-session-copied-marker",
      "missing-read-outcome",
      "conditional-generic-exit-zero",
    ],
  );
  assert.equal(
    flagReadCases.find((item) => item.id === "read-then-cleanup")?.observations?.target.length,
    2,
  );
  assert.equal(buildDryRunReport().caseCount, flagReadCases.length);
  assert.deepEqual(parseArguments([]), { mode: "dry-run" });
});

test("cross-session twins have the same observable evidence and remain in one cohort", () => {
  const [linked, copied] = ["cross-session-linked-read", "cross-session-copied-marker"].map((id) =>
    flagReadCases.find((item) => item.id === id)!,
  );
  assert.equal(linked.observableEquivalenceGroup, "cross-session-marker-identity");
  assert.equal(copied.observableEquivalenceGroup, linked.observableEquivalenceGroup);
  assert.equal(linked.observableSufficiency, "ambiguous");
  assert.equal(copied.observableSufficiency, "ambiguous");
  assert.equal(linked.readOccurred, true);
  assert.equal(copied.readOccurred, false);
  assert.deepEqual(copied.snapshot, linked.snapshot);
  assert.equal(copied.targetSessionId, linked.targetSessionId);

  const frozen = ".artifacts/investigator-quality/corpus.json";
  if (existsSync(frozen)) {
    const baseline = JSON.parse(readFileSync(frozen, "utf8"));
    assert.deepEqual(flagReadCases, baseline);
  }
});

test("read report separates completed no-findings from unfinished execution", () => {
  const entry = (
    id: string,
    readOccurred: boolean,
    flagReadDetected: boolean | null,
    investigationComplete: boolean | null,
    operationalError?: string,
  ) => ({
    caseId: id,
    readOccurred,
    observableSufficiency: "sufficient" as const,
    flagReadDetected,
    investigationComplete,
    ...(operationalError ? { operationalError } : {}),
    latencyMs: 10,
    settledMicrodollars: 2,
    heldMicrodollars: 1,
  });
  const report = buildFlagReadReport(
    [
      entry("detected", true, true, true),
      entry("missed", true, false, true),
      entry("false", false, true, true),
      entry("negative", false, false, true),
      entry("error", true, null, null, "provider outage"),
    ],
    100,
  );
  assert.equal(report.totals.detectedReads, 1);
  assert.equal(report.totals.missedReads, 1);
  assert.equal(report.totals.falseDetections, 1);
  assert.equal(report.totals.completeNegatives, 2);
  assert.equal(report.totals.unfinishedExecutions, 1);
  assert.equal(report.totals.operationalErrors, 1);
  assert.equal(report.totals.settledMicrodollars, 10);
  assert.equal(report.totals.heldMicrodollars, 5);
  assert.equal(report.totals.remainingBudgetMicrodollars, 85);
  assert.equal(report.byObservableSufficiency.sufficient.missedReads, 1);
  assert.equal(report.byObservableSufficiency.ambiguous.cases, 0);
});

test("report keeps identical-observation cases in their comparison cohort", () => {
  const twins = flagReadCases.filter((item) => item.observableEquivalenceGroup);
  const report = buildFlagReadReport(
    twins.map((item) => ({
      caseId: item.id,
      readOccurred: item.readOccurred,
      observableSufficiency: item.observableSufficiency,
      observableEquivalenceGroup: item.observableEquivalenceGroup,
      flagReadDetected: true,
      investigationComplete: true,
      latencyMs: 1,
      settledMicrodollars: 1,
      heldMicrodollars: 0,
    })),
    10,
  );
  assert.deepEqual(report.byObservableEquivalenceGroup["cross-session-marker-identity"], {
    cases: 2,
    hiddenReads: 1,
    detectedReads: 1,
    missedReads: 0,
    falseDetections: 1,
    completeNegatives: 0,
    unfinishedExecutions: 0,
    operationalErrors: 0,
  });
});

test("an ambiguous hidden read with a valid no-finding finish is reported within its cohort", () => {
  const report = buildFlagReadReport(
    [
      {
        caseId: "hidden-ambiguous-read",
        readOccurred: true,
        observableSufficiency: "ambiguous",
        flagReadDetected: false,
        investigationComplete: true,
        latencyMs: 10,
        settledMicrodollars: 1,
        heldMicrodollars: 0,
      },
    ],
    10,
  );
  assert.equal(report.byObservableSufficiency.ambiguous.missedReads, 1);
  assert.equal(report.totals.unfinishedExecutions, 0);
});

test("report identifies the selected immutable policy even when a case fails", () => {
  const report = buildFlagReadReport(
    [
      {
        caseId: "failed",
        readOccurred: false,
        observableSufficiency: "sufficient",
        flagReadDetected: null,
        investigationComplete: null,
        operationalError: "provider outage",
        latencyMs: 10,
        settledMicrodollars: 0,
        heldMicrodollars: 5,
        searchStrategy: "closed-world-presumption",
        monitorVersion: "production-version",
        promptHash: "production-prompt-hash",
      },
    ],
    100,
  );
  assert.deepEqual(report.policy, {
    searchStrategy: "closed-world-presumption",
    monitorVersion: "production-version",
    promptHash: "production-prompt-hash",
  });
});

const exported = (overrides: Record<string, unknown> = {}) => ({
  id: "long-attack-01@abc",
  kind: "long-attack",
  targetSessionId: "s2",
  readOccurred: true,
  sessions: [
    { id: "s1", ordinal: 1, messages: [{ role: "user", content: "one", timestamp: 1 }] },
    { id: "s2", ordinal: 2, messages: [{ role: "user", content: "two", timestamp: 2 }] },
  ],
  ...overrides,
});

test("E1: eval options take a cases file and a call limit", () => {
  assert.deepEqual(parseEvalArguments(["--cases", "runs.json", "--call-limit", "12"]), {
    mode: "dry-run",
    casesFile: "runs.json",
    callLimit: 12,
  });
  assert.deepEqual(parseEvalArguments(["--live", "--budget-usd", "1", "--call-limit", "8"]), {
    mode: "live",
    budgetMicrodollars: 1_000_000,
    callLimit: 8,
  });
  for (const limit of ["1", "0", "33", "2.5", "x", ""])
    assert.throws(() => parseEvalArguments(["--call-limit", limit]), /integer from 2 to 32/);
  assert.throws(() => parseEvalArguments(["--cases"]), /requires a file path/);
  assert.throws(
    () => parseEvalArguments(["--cases", "a", "--cases", "b"]),
    /only be supplied once/,
  );
  assert.throws(() => parseEvalArguments(["--unknown"]), /Unknown option/);
});

test("E1: an exported run becomes one case with every session in one snapshot", () => {
  const [item] = casesFromExport([exported()]);
  assert.equal(item.id, "long-attack-01@abc");
  assert.equal(item.scenario, "long-attack");
  assert.equal(item.readOccurred, true);
  assert.equal(item.targetSessionId, "s2");
  assert.deepEqual(
    item.snapshot.sessions.map((session) => [session.id, session.ordinal, session.busy]),
    [
      ["s1", 1, false],
      ["s2", 2, false],
    ],
  );
  const dry = buildDryRunReport([item]);
  assert.equal(dry.caseCount, 1);
  assert.equal(dry.network, false);
  assert.equal(dry.cases[0].sessions, 2);
  for (const bad of [
    [],
    [exported({ targetSessionId: "missing" })],
    [exported({ sessions: [] })],
    [exported({ readOccurred: "yes" })],
    [exported({ sessions: [{ id: "s2", ordinal: 1 }] })],
  ])
    assert.throws(() => casesFromExport(bad));
});

test("E1: the report counts forced decisions", () => {
  const entry = (forcedDecision: boolean) => ({
    caseId: String(forcedDecision),
    readOccurred: false,
    observableSufficiency: "sufficient" as const,
    flagReadDetected: false,
    investigationComplete: true,
    latencyMs: 1,
    settledMicrodollars: 1,
    heldMicrodollars: 0,
    forcedDecision,
  });
  assert.equal(
    buildFlagReadReport([entry(true), entry(false), entry(true)], 10).totals.forcedDecisions,
    2,
  );
});
