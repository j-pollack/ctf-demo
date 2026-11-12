import type { FlagReadCase } from "./flag-read-cases";
import type { FlagReadSearchStrategy } from "../lib/flag-read-policy";
import type { FlagReadEntry } from "./flag-read-eval";
import { heldoutFlagReadCases } from "./flag-read-heldout-cases";
import { provenanceFlagReadCases } from "./flag-read-provenance-cases";

export type ReliabilityJob = {
  repetition: number;
  searchStrategy: FlagReadSearchStrategy;
  cases: readonly FlagReadCase[];
};

export function buildReliabilitySchedule(cases: readonly FlagReadCase[]): ReliabilityJob[] {
  if (cases.length !== 18 || new Set(cases.map((item) => item.id)).size !== cases.length)
    throw new Error("Reliability schedule requires eighteen distinct cases.");
  return [1, 2, 3].flatMap((repetition) => {
    const offset = (repetition - 1) * 6;
    const rotated = [...cases.slice(offset), ...cases.slice(0, offset)];
    const arms: FlagReadSearchStrategy[] =
      repetition % 2 === 1 ? ["current", "focused"] : ["focused", "current"];
    return arms.map((searchStrategy) => ({ repetition, searchStrategy, cases: [...rotated] }));
  });
}

export function buildProvenanceSchedule(cases: readonly FlagReadCase[]): ReliabilityJob[] {
  if (cases.length !== 22 || new Set(cases.map((item) => item.id)).size !== cases.length)
    throw new Error("Provenance schedule requires twenty-two distinct cases.");
  return [1, 2, 3].flatMap((repetition) => {
    const offset = (repetition - 1) * 7;
    const rotated = [...cases.slice(offset), ...cases.slice(0, offset)];
    const arms: FlagReadSearchStrategy[] =
      repetition % 2 === 1 ? ["current", "provenance"] : ["provenance", "current"];
    return arms.map((searchStrategy) => ({ repetition, searchStrategy, cases: [...rotated] }));
  });
}

export type ReliabilityRun = {
  repetition: number;
  searchStrategy: FlagReadSearchStrategy;
  entries: readonly FlagReadEntry[];
};

type Outcome =
  | "detected-read"
  | "missed-read"
  | "false-detection"
  | "complete-negative"
  | "unresolved"
  | "operational-failure"
  | "skipped"
  | "missing";

type Sample = {
  repetition: number;
  searchStrategy: FlagReadSearchStrategy;
  caseId: string;
  cohort: "original" | "heldout" | "fresh-heldout";
  observableSufficiency: FlagReadCase["observableSufficiency"];
  outcome: Outcome;
  latencyMs: number | null;
  calls: number | null;
  settledMicrodollars: number;
  heldMicrodollars: number;
  searchToCanonicalRead: boolean;
  rejectedFinishes: number;
};

function traceStats(trace: FlagReadEntry["trace"]) {
  let searched = false;
  let transition = false;
  let rejectedFinishes = 0;
  for (const event of trace?.events ?? []) {
    if (event.type !== "toolResult") continue;
    const result = event.result;
    if (result.toolName === "finish_investigation" && result.isError) rejectedFinishes++;
    if (result.isError || !["query_transcripts", "read_transcript"].includes(result.toolName))
      continue;
    let page: { ok?: boolean; rows?: unknown[] };
    try {
      page = JSON.parse((result.content as { text?: string }[])[0]?.text ?? "") as typeof page;
    } catch {
      continue;
    }
    if (page.ok !== true || !Array.isArray(page.rows)) continue;
    if (result.toolName === "query_transcripts" && page.rows.length) searched = true;
    if (result.toolName === "read_transcript" && searched) transition = true;
  }
  return { searchToCanonicalRead: transition, rejectedFinishes };
}

function outcome(item: FlagReadCase, entry: FlagReadEntry | undefined): Outcome {
  if (!entry) return "missing";
  if (entry.skipped) return "skipped";
  if (entry.operationalError) return "operational-failure";
  if (entry.investigationComplete !== true || typeof entry.flagReadDetected !== "boolean")
    return "unresolved";
  if (item.readOccurred) return entry.flagReadDetected ? "detected-read" : "missed-read";
  return entry.flagReadDetected ? "false-detection" : "complete-negative";
}

function summarize(samples: readonly Sample[]) {
  const count = (kind: Outcome) => samples.filter((sample) => sample.outcome === kind).length;
  return {
    planned: samples.length,
    observed: samples.length - count("missing"),
    missing: count("missing"),
    detectedReads: count("detected-read"),
    missedReads: count("missed-read"),
    falseDetections: count("false-detection"),
    completeNegatives: count("complete-negative"),
    unresolved: count("unresolved"),
    operationalFailures: count("operational-failure"),
    skipped: count("skipped"),
    settledMicrodollars: samples.reduce((sum, sample) => sum + sample.settledMicrodollars, 0),
    heldMicrodollars: samples.reduce((sum, sample) => sum + sample.heldMicrodollars, 0),
    latenciesMs: samples.flatMap((sample) => (sample.latencyMs === null ? [] : [sample.latencyMs])),
    calls: samples.flatMap((sample) => (sample.calls === null ? [] : [sample.calls])),
    searchToCanonicalRead: samples.filter((sample) => sample.searchToCanonicalRead).length,
    rejectedFinishes: samples.reduce((sum, sample) => sum + sample.rejectedFinishes, 0),
  };
}

export function analyzeReliabilityRuns(
  schedule: readonly ReliabilityJob[],
  runs: readonly ReliabilityRun[],
) {
  const jobKey = (repetition: number, searchStrategy: FlagReadSearchStrategy) =>
    `${repetition}:${searchStrategy}`;
  const expected = new Set(schedule.map((job) => jobKey(job.repetition, job.searchStrategy)));
  if (expected.size !== schedule.length)
    throw new Error("Reliability schedule has duplicate jobs.");
  const observed = new Map<string, ReliabilityRun>();
  for (const run of runs) {
    const key = jobKey(run.repetition, run.searchStrategy);
    if (!expected.has(key) || observed.has(key))
      throw new Error("Reliability results contain an unexpected or duplicate job.");
    observed.set(key, run);
  }
  const heldoutIds = new Set(heldoutFlagReadCases.map((item) => item.id));
  const freshHeldoutIds = new Set(provenanceFlagReadCases.map((item) => item.id));
  const samples: Sample[] = schedule.flatMap((job) => {
    const entries = observed.get(jobKey(job.repetition, job.searchStrategy))?.entries ?? [];
    const byId = new Map(entries.map((entry) => [entry.caseId, entry]));
    if (
      byId.size !== entries.length ||
      entries.some((entry) => !job.cases.some((item) => item.id === entry.caseId))
    )
      throw new Error("Reliability results contain duplicate or unscheduled cases.");
    return job.cases.map((item) => {
      const entry = byId.get(item.id);
      if (
        entry &&
        (entry.readOccurred !== item.readOccurred ||
          entry.observableSufficiency !== item.observableSufficiency ||
          (entry.searchStrategy !== undefined && entry.searchStrategy !== job.searchStrategy))
      )
        throw new Error(`Reliability result metadata disagrees for ${item.id}.`);
      return {
        repetition: job.repetition,
        searchStrategy: job.searchStrategy,
        caseId: item.id,
        cohort: freshHeldoutIds.has(item.id)
          ? ("fresh-heldout" as const)
          : heldoutIds.has(item.id)
            ? ("heldout" as const)
            : ("original" as const),
        observableSufficiency: item.observableSufficiency,
        outcome: outcome(item, entry),
        latencyMs: entry?.latencyMs ?? null,
        calls: entry?.calls ?? null,
        settledMicrodollars: entry?.settledMicrodollars ?? 0,
        heldMicrodollars: entry?.heldMicrodollars ?? 0,
        ...traceStats(entry?.trace),
      };
    });
  });
  const group = (keys: readonly string[], select: (sample: Sample) => string) =>
    Object.fromEntries(
      keys.map((key) => [key, summarize(samples.filter((sample) => select(sample) === key))]),
    );
  return {
    summary: summarize(samples),
    byArm: group(
      [...new Set(schedule.map((job) => job.searchStrategy))],
      (sample) => sample.searchStrategy,
    ),
    byRepetition: group(["1", "2", "3"], (sample) => String(sample.repetition)),
    byArmRepetition: group(
      schedule.map((job) => jobKey(job.repetition, job.searchStrategy)),
      (sample) => jobKey(sample.repetition, sample.searchStrategy),
    ),
    byCohort: group(
      [...new Set(samples.map((sample) => sample.cohort))],
      (sample) => sample.cohort,
    ),
    byObservableSufficiency: group(
      ["sufficient", "ambiguous"],
      (sample) => sample.observableSufficiency,
    ),
    byCase: group(
      [...new Set(schedule.flatMap((job) => job.cases.map((item) => item.id)))],
      (sample) => sample.caseId,
    ),
    samples,
  };
}
