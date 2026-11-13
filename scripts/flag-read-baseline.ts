import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { toFlagReadCase, scoreCorpusEntries, type CorpusCase } from "./flag-read-corpus";
import type { FlagReadEntry } from "./flag-read-eval";
import { resolveFlagReadPolicy } from "../lib/flag-read-policy";
import { INVESTIGATOR_MODEL } from "../lib/policy";
import { TYPESAFE_MODEL } from "../lib/typesafe";

type SplitCase = CorpusCase & { split: "dev" | "test" };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const policy = resolveFlagReadPolicy("current");

export function selectBaseline(cases: readonly SplitCase[]) {
  const ids = new Set<string>();
  const pairs = new Map<string, SplitCase[]>();
  for (const item of cases) {
    if (ids.has(item.id) || !["dev", "test"].includes(item.split))
      throw new Error("Duplicate ID or invalid split.");
    ids.add(item.id);
    pairs.set(item.pair, [...(pairs.get(item.pair) ?? []), item]);
  }
  for (const pair of pairs.values()) {
    if (
      pair.length !== 2 ||
      new Set(pair.map((x) => x.kind)).size !== 2 ||
      new Set(pair.map((x) => x.split)).size !== 1 ||
      new Set(pair.map((x) => x.family)).size !== 1
    )
      throw new Error("Broken corpus pair.");
  }
  const selected = cases
    .filter((x) => x.split === "dev")
    .sort((a, b) => a.id.localeCompare(b.id, "en"));
  if (selected.length !== 72) throw new Error("Baseline requires exactly 72 dev cases.");
  selected.forEach((item) => toFlagReadCase(item, "strict"));
  return selected;
}

export function buildSchedule(corpusText: string, sources: Record<string, string>) {
  const selected = selectBaseline(JSON.parse(corpusText));
  return {
    version: 1,
    mode: "offline-only",
    evaluationPerformed: false,
    corpusSha256: hash(corpusText),
    sources: Object.fromEntries(
      Object.entries(sources)
        .sort()
        .map(([path, text]) => [path, hash(text)]),
    ),
    policy: {
      strategy: "current",
      monitorVersion: policy.monitorVersion,
      promptHash: policy.promptHash,
      investigatorModel: INVESTIGATOR_MODEL,
      effort: "high",
      classifierModel: TYPESAFE_MODEL,
    },
    execution: {
      concurrency: 1,
      attemptsPerCase: 1,
      retries: 0,
      cases: 72,
      investigatorCallsPerCase: 8,
      investigatorCallsMaximum: 576,
      classifierCallsPerCase: 1,
      classifierCallsMaximum: 72,
      investigatorOutputTokensPerCall: 8192,
      investigatorDeadlineMs: 60000,
      scoring: ["strict", "presumption"],
      note: "One investigation per case; the same outcome is scored under both standards. No live runner is enabled by this wrapper.",
    },
    budget: {
      proposedMicrodollars: 10_000_000,
      perCasePlanningAllowanceMicrodollars: 125_000,
      contingencyMicrodollars: 1_000_000,
      pricing: null,
      basis:
        "72 × $0.125 allowance + $1 contingency = $10. This is a proposed stop budget, not a price-derived estimate or guarantee that all cases finish. Refresh provider pricing and verify enforcement before paid execution. Settled charges plus unresolved holds consume the budget.",
    },
    artifacts: {
      entries: ".artifacts/flag-read-baseline/entries.json",
      summary: ".artifacts/flag-read-baseline/summary.json",
      note: "Preserve raw entries including traces. Missing usage/completions are unknown, never zero-filled.",
    },
    cases: selected.map((item, index) => ({
      ordinal: index + 1,
      id: item.id,
      pair: item.pair,
      family: item.family,
      strict: item.strict,
      presumption: item.presumption,
      readOccurred: item.readOccurred,
    })),
  };
}

export function summarizeBaseline(
  corpusText: string,
  entries: readonly FlagReadEntry[],
  schedule: ReturnType<typeof buildSchedule>,
) {
  if (hash(corpusText) !== schedule.corpusSha256)
    throw new Error("Corpus differs from frozen schedule.");
  const selected = selectBaseline(JSON.parse(corpusText));
  if (JSON.stringify(buildSchedule(corpusText, {}).cases) !== JSON.stringify(schedule.cases))
    throw new Error("Case selection differs from frozen schedule.");
  for (const entry of entries) {
    if (
      entry.searchStrategy !== schedule.policy.strategy ||
      entry.monitorVersion !== schedule.policy.monitorVersion ||
      entry.promptHash !== schedule.policy.promptHash ||
      (entry.investigatorModel !== undefined
        ? entry.investigatorModel !== schedule.policy.investigatorModel
        : !entry.skipped && !(entry.operationalError && entry.investigationComplete !== true))
    )
      throw new Error("Result does not match baseline policy/model.");
    if (
      ![entry.settledMicrodollars, entry.heldMicrodollars].every(
        (n) => Number.isSafeInteger(n) && n >= 0,
      )
    )
      throw new Error("Invalid result accounting.");
  }
  const scores = scoreCorpusEntries(entries, selected);
  return {
    scores,
    perFamily: Object.fromEntries(
      [...new Set(selected.map((x) => x.family))].sort().map((family) => {
        const items = selected.filter((x) => x.family === family);
        return [
          family,
          scoreCorpusEntries(
            entries.filter((e) => items.some((x) => x.id === e.caseId)),
            items,
          ),
        ];
      }),
    ),
    missing: selected.filter((x) => !entries.some((e) => e.caseId === x.id)).map((x) => x.id),
    settledMicrodollars: entries.reduce((sum, x) => sum + x.settledMicrodollars, 0),
    heldMicrodollars: entries.reduce((sum, x) => sum + x.heldMicrodollars, 0),
    latencyMs: entries.map((x) => ({ caseId: x.caseId, latencyMs: x.latencyMs })),
    entries,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, output] = process.argv.slice(2);
  if (command !== "--dry-run" || !output || process.argv.length !== 4)
    throw new Error(
      "Usage: node --import tsx scripts/flag-read-baseline.ts --dry-run <schedule.json>",
    );
  const paths = [
    "scripts/flag-read-baseline.ts",
    "scripts/flag-read-corpus.ts",
    "scripts/flag-read-scenarios.ts",
    "scripts/flag-read-eval-live.ts",
    "scripts/monitor-investigate-eval-live.ts",
    "lib/policy.ts",
    "lib/flag-read-policy.ts",
    "lib/monitor-evidence.ts",
    "lib/investigator-driver.ts",
    "lib/typesafe.ts",
    "lib/monitor-classifier.ts",
    "package-lock.json",
  ];
  const schedule = buildSchedule(
    readFileSync("evals/flag-read/cases.json", "utf8"),
    Object.fromEntries(paths.map((path) => [path, readFileSync(path, "utf8")])),
  );
  writeFileSync(output, `${JSON.stringify(schedule, null, 2)}\n`, { flag: "wx" });
  console.log(
    `Scheduled ${schedule.cases.length} cases; proposed cap $10; no evaluation performed.`,
  );
}
