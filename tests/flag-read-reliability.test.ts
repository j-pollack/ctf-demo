import assert from "node:assert/strict";
import { test } from "node:test";
import { flagReadCases } from "../scripts/flag-read-cases";
import { heldoutFlagReadCases } from "../scripts/flag-read-heldout-cases";
import { analyzeReliabilityRuns, buildReliabilitySchedule } from "../scripts/flag-read-reliability";
import type { FlagReadEntry } from "../scripts/flag-read-eval";

test("heldouts are separate sufficient cases with visibly distinguishable loaded source", () => {
  assert.equal(flagReadCases.length, 14);
  assert.equal(heldoutFlagReadCases.length, 4);
  assert.deepEqual(
    heldoutFlagReadCases.map((item) => item.readOccurred),
    [true, false, false, true],
  );
  assert.ok(heldoutFlagReadCases.every((item) => item.observableSufficiency === "sufficient"));
  assert.equal(
    new Set([...flagReadCases, ...heldoutFlagReadCases].map((item) => item.id)).size,
    18,
  );
  const [positive, negative, overwritten, distracting] = heldoutFlagReadCases;
  const visibleTarget = (item: typeof positive) =>
    item.snapshot.sessions.find((session) => session.id === item.targetSessionId)!.messages;
  const targetCommand = (item: typeof positive) =>
    JSON.stringify(visibleTarget(item).find((message) => message.role === "assistant"));
  const targetOutput = (item: typeof positive) =>
    JSON.stringify(visibleTarget(item).find((message) => message.role === "toolResult"));
  assert.equal(targetCommand(positive), targetCommand(negative));
  assert.match(targetCommand(positive), /exec\(compile\(source/);
  assert.match(targetOutput(positive), /read_bytes/);
  assert.doesNotMatch(targetOutput(negative), /read_bytes/);
  assert.match(targetOutput(negative), /print\('read-ok/);
  assert.deepEqual(positive.snapshot.sessions[1], negative.snapshot.sessions[1]);
  assert.match(JSON.stringify(visibleTarget(overwritten)), /read_bytes/);
  assert.match(JSON.stringify(visibleTarget(overwritten)), /report complete/);
  assert.match(JSON.stringify(visibleTarget(distracting)), /cat \/tmp\/flag\.txt/);
  const lastResult = visibleTarget(distracting).findLast(
    (message) => message.role === "toolResult",
  );
  assert.ok(lastResult && JSON.stringify(lastResult).length > 8 * 1024);
  assert.ok(distracting.sameOwnerHistory);
  for (const item of heldoutFlagReadCases) {
    assert.ok(!JSON.stringify(item.snapshot).includes(item.id));
    assert.ok(!JSON.stringify(item.snapshot).includes(item.scenario));
  }
});

test("repeated analysis keeps all planned denominators and separates missing, unresolved and errors", () => {
  const schedule = buildReliabilitySchedule([...flagReadCases, ...heldoutFlagReadCases]);
  const negative = flagReadCases[0];
  const positive = heldoutFlagReadCases[0];
  const entry = (
    item: typeof negative,
    flagReadDetected: boolean | null,
    investigationComplete: boolean | null,
    extras: Partial<FlagReadEntry> = {},
  ): FlagReadEntry => ({
    caseId: item.id,
    readOccurred: item.readOccurred,
    observableSufficiency: item.observableSufficiency,
    flagReadDetected,
    investigationComplete,
    latencyMs: 10,
    settledMicrodollars: 3,
    heldMicrodollars: 1,
    ...extras,
  });
  const trace: NonNullable<FlagReadEntry["trace"]> = {
    events: [
      { sequence: 0, type: "initialEvidence", evidence: {} },
      {
        sequence: 1,
        type: "toolResult",
        result: {
          toolName: "query_transcripts",
          toolCallId: "q",
          arguments: {},
          isError: false,
          content: [{ type: "text", text: '{"ok":true,"rows":[{"text":"lead"}]}' }],
        },
      },
      {
        sequence: 2,
        type: "toolResult",
        result: {
          toolName: "read_transcript",
          toolCallId: "r",
          arguments: {},
          isError: false,
          content: [{ type: "text", text: '{"ok":true,"rows":[]}' }],
        },
      },
      {
        sequence: 3,
        type: "toolResult",
        result: {
          toolName: "finish_investigation",
          toolCallId: "f",
          arguments: {},
          isError: true,
          content: [],
        },
      },
    ],
    omittedEvents: 0,
    omittedBytes: 0,
    recordingErrors: 0,
    recordingErrorCodes: [],
  };
  const report = analyzeReliabilityRuns(schedule, [
    {
      repetition: 1,
      searchStrategy: "current",
      entries: [entry(negative, false, true, { calls: 3, trace })],
    },
    {
      repetition: 1,
      searchStrategy: "focused",
      entries: [
        entry(negative, true, true, { calls: 2, latencyMs: 20 }),
        entry(positive, null, null, { operationalError: "provider outage", latencyMs: 30 }),
        entry(heldoutFlagReadCases[1], null, null, { latencyMs: null }),
        entry(flagReadCases[1], null, null, {
          skipped: true,
          operationalError: "Evaluation budget exhausted before classifier admission.",
          latencyMs: null,
        }),
      ],
    },
  ]);
  assert.equal(report.summary.planned, 108);
  assert.equal(report.summary.observed, 5);
  assert.equal(report.summary.missing, 103);
  assert.equal(report.summary.completeNegatives, 1);
  assert.equal(report.summary.falseDetections, 1);
  assert.equal(report.summary.operationalFailures, 1);
  assert.equal(report.summary.skipped, 1);
  assert.equal(report.summary.unresolved, 1);
  assert.equal(report.summary.searchToCanonicalRead, 1);
  assert.equal(report.summary.rejectedFinishes, 1);
  assert.deepEqual(report.summary.latenciesMs, [10, 20, 30]);
  assert.deepEqual(report.summary.calls, [3, 2]);
  assert.equal(report.byArm.current.planned, 54);
  assert.equal(report.byArm.focused.planned, 54);
  assert.equal(report.byRepetition[1].planned, 36);
  assert.equal(report.byCohort.original.planned, 84);
  assert.equal(report.byCohort.heldout.planned, 24);
  assert.equal(report.byObservableSufficiency.ambiguous.planned, 24);
  assert.equal(report.byCase[negative.id].planned, 6);
  assert.equal(report.byCase[negative.id].observed, 2);
  assert.equal(report.samples.length, 108);
  assert.ok(report.samples.some((sample: { outcome: string }) => sample.outcome === "missing"));
  assert.ok(!("confidenceInterval" in report));
});

test("schedule pairs all eighteen cases three times with deterministic rotations", () => {
  const all = [...flagReadCases, ...heldoutFlagReadCases];
  const original = JSON.stringify(all);
  const schedule = buildReliabilitySchedule(all);
  assert.equal(schedule.length, 6);
  assert.deepEqual(
    schedule.map((job: any) => job.searchStrategy),
    ["current", "focused", "focused", "current", "current", "focused"],
  );
  for (let repetition = 1; repetition <= 3; repetition++) {
    const pair = schedule.filter((job: any) => job.repetition === repetition) as any[];
    assert.equal(pair.length, 2);
    assert.deepEqual(
      pair[0].cases.map((item: any) => item.id),
      pair[1].cases.map((item: any) => item.id),
    );
    assert.equal(pair[0].cases.length, 18);
    assert.deepEqual(
      new Set(pair[0].cases.map((item: any) => item.id)),
      new Set(all.map((item) => item.id)),
    );
    assert.equal(pair[0].cases[0].id, all[((repetition - 1) * 6) % all.length].id);
  }
  assert.equal(JSON.stringify(all), original);
});
