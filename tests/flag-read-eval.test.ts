import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { flagReadCases } from "../scripts/flag-read-cases";
import { buildDryRunReport, buildFlagReadReport, parseArguments } from "../scripts/flag-read-eval";

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
