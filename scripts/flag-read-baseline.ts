import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { toFlagReadCase, scoreCorpusEntries, type CorpusCase } from "./flag-read-corpus";
import type { FlagReadEntry } from "./flag-read-eval";
import { resolveFlagReadPolicy } from "../lib/flag-read-policy";
import { INVESTIGATOR_MODEL } from "../lib/policy";
import { TYPESAFE_MODEL } from "../lib/typesafe";
import { baselineSources } from "./flag-read-baseline-files";
import { BOUNDED_INVESTIGATOR_POLICY } from "../lib/investigator-evaluation-policy";

type SplitCase = CorpusCase & { split: "dev" | "test" };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

export type BaselineStrategy = "current" | "closed-world-presumption-v1";

export function parseBaselineStrategy(value: string): BaselineStrategy {
  if (value === "current" || value === "closed-world-presumption-v1") return value;
  throw new Error("Baseline strategy must be current or closed-world-presumption-v1.");
}

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

export function buildSchedule(
  corpusText: string,
  sources: Record<string, string>,
  strategy: BaselineStrategy = "current",
) {
  const policy = resolveFlagReadPolicy(parseBaselineStrategy(strategy));
  const selected = selectBaseline(JSON.parse(corpusText));
  return {
    version: 2,
    mode: "planned",
    evaluationPerformed: false,
    corpusSha256: hash(corpusText),
    sources: Object.fromEntries(
      Object.entries(sources)
        .sort()
        .map(([path, text]) => [path, hash(text)]),
    ),
    policy: {
      strategy,
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
      investigatorDeadlineMs: BOUNDED_INVESTIGATOR_POLICY.deadlineMs,
      classifierDeadlineMs: BOUNDED_INVESTIGATOR_POLICY.classifierDeadlineMs,
      reviewClaimMs: BOUNDED_INVESTIGATOR_POLICY.claimMs,
      provider: {
        only: [BOUNDED_INVESTIGATOR_POLICY.providerEndpoint],
        allow_fallbacks: false,
        require_parameters: true,
        max_price: {
          prompt: BOUNDED_INVESTIGATOR_POLICY.inputUsdPerMillion,
          completion: BOUNDED_INVESTIGATOR_POLICY.outputUsdPerMillion,
          request: 0,
        },
      },
      scoring: ["strict", "presumption"],
      note: "One investigation per case; both standards score the same outcome. Live execution requires explicit budget authorization, frozen source preflight and a fresh local database. No retries, including HTTP 429 retries.",
    },
    budget: {
      proposedMicrodollars: 10_000_000,
      perCasePlanningAllowanceMicrodollars: 125_000,
      contingencyMicrodollars: 1_000_000,
      pricing: {
        checkedAt: "2026-11-13",
        investigator: {
          source: "https://openrouter.ai/api/v1/models/z-ai/glm-5.3/endpoints",
          model: "z-ai/glm-5.3",
          canonicalSlug: "z-ai/glm-5.3-20260816",
          providerEndpoint: BOUNDED_INVESTIGATOR_POLICY.providerEndpoint,
          inputUsdPerMillion: BOUNDED_INVESTIGATOR_POLICY.inputUsdPerMillion,
          outputUsdPerMillion: BOUNDED_INVESTIGATOR_POLICY.outputUsdPerMillion,
        },
        classifier: {
          source: "https://docs.typesafe.ai/models.md",
          model: "jev-1.14.0",
          inputUsdPerMillion: 0.042,
          outputUsdPerMillion: 0,
        },
        note: "Frozen DigitalOcean endpoint rate ceilings feed reservations and max_price; no provider fallback. Price increases beyond these ceilings fail rather than expand the budget. Actual charges are persisted; reservation overruns stop subsequent dispatch.",
      },
      basis: `72 × $0.125 allowance + $1 contingency = $10. This is a proposed stop budget, not a guarantee that all cases finish. At the frozen rate, 576 calls each consuming all 8192 output tokens would cost $${((576 * 8192 * BOUNDED_INVESTIGATOR_POLICY.outputUsdPerMillion) / 1e6).toFixed(7)} in output alone. Settled charges plus unresolved holds consume the budget; cases may remain incomplete.`,
    },
    artifacts: {
      entries: "entries.jsonl",
      summary: "summary.json",
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
  const [command, output, selection, strategy] = process.argv.slice(2);
  if (
    command !== "--dry-run" ||
    !output ||
    output.startsWith("--") ||
    !(process.argv.length === 4 || (process.argv.length === 6 && selection === "--strategy"))
  )
    throw new Error(
      "Usage: node --import tsx scripts/flag-read-baseline.ts --dry-run <NEW_schedule.json> [--strategy current|closed-world-presumption-v1]",
    );
  const schedule = buildSchedule(
    readFileSync("evals/flag-read/cases.json", "utf8"),
    baselineSources(),
    parseBaselineStrategy(strategy ?? "current"),
  );
  writeFileSync(output, `${JSON.stringify(schedule, null, 2)}\n`, { flag: "wx" });
  console.log(
    `Scheduled ${schedule.cases.length} cases; proposed cap $10; no evaluation performed.`,
  );
}
