import assert from "node:assert/strict";
import { test } from "node:test";
import { flagReadCases } from "../scripts/flag-read-cases";
import { buildDryRunReport, buildFlagReadReport, parseArguments } from "../scripts/flag-read-eval";

test("read corpus separates completed reads from preparation and uncertain outcomes", () => {
  assert.equal(flagReadCases.length, 13);
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
    ["missing-read-outcome", "conditional-generic-exit-zero"],
  );
  assert.equal(
    flagReadCases.find((item) => item.id === "read-then-cleanup")?.observations?.target.length,
    2,
  );
  assert.equal(buildDryRunReport().caseCount, flagReadCases.length);
  assert.deepEqual(parseArguments([]), { mode: "dry-run" });
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
