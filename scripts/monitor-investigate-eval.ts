import {
  monitorInvestigationCases,
  type MonitorCaseExpectation,
} from "./monitor-investigation-cases";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type EvaluationArguments = {
  mode: "dry-run" | "live" | "help";
  budgetMicrodollars?: number;
};

export type EvaluationEnvironment = {
  [key: string]: string | undefined;
  CTF_INTEGRATION_DATABASE_URL?: string | undefined;
  OPENROUTER_API_KEY?: string | undefined;
  TYPESAFE_API_KEY?: string | undefined;
};

export type LiveEvaluationConfig = {
  databaseUrl: string;
  budgetMicrodollars: number;
};

export type EvaluationEntry = {
  caseId: string;
  reviewId?: string;
  expected: MonitorCaseExpectation;
  classifierRisk: number | null;
  classifierThreshold: number;
  baselineCaught: boolean | null;
  verdict: "allow" | "block" | "unknown" | null;
  operationalError?: string;
  latencyMs: number | null;
  initialEvidenceCount: number | null;
  retrievedReferences: string[] | null;
  retrievalCalls: number | null;
  classifierModel: string;
  investigatorModel: string;
  monitorVersion: string;
  settledMicrodollars: number;
  heldMicrodollars: number;
  staleEvidence?: {
    reviewedRevision: number;
    currentRevision: number;
    scope: "snapshot-only-monitor-judgment";
  };
};

const STALE_EVIDENCE_LIMITATION =
  "Stale-evidence cases judge the current snapshot only; this evaluator does not exercise stale-revision admission fencing.";

export function parseArguments(args: string[]): EvaluationArguments {
  let mode: EvaluationArguments["mode"] = "dry-run";
  let budgetMicrodollars: number | undefined;
  let liveSelected = false;
  let dryRunSelected = false;
  let dryRunArgument = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      if (args.length !== 1) throw new Error("--help cannot be combined with other options.");
      return { mode: "help" };
    }
    if (arg === "--live") {
      if (liveSelected) throw new Error("--live may only be supplied once.");
      if (dryRunSelected) throw new Error("--live cannot be combined with --dry-run.");
      liveSelected = true;
      mode = "live";
      continue;
    }
    if (arg === "--dry-run") {
      if (liveSelected) throw new Error("--dry-run cannot be combined with --live.");
      if (dryRunArgument) throw new Error("--dry-run may only be supplied once.");
      dryRunArgument = true;
      dryRunSelected = true;
      continue;
    }
    if (arg === "--budget-usd") {
      if (budgetMicrodollars !== undefined)
        throw new Error("--budget-usd may only be supplied once.");
      const raw = args[++index];
      if (!raw || !/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(raw))
        throw new Error(
          "--budget-usd must be a positive decimal with at most six fractional digits.",
        );
      const [whole, fraction = ""] = raw.split(".");
      const microdollars = Number(whole) * 1_000_000 + Number(fraction.padEnd(6, "0"));
      if (!Number.isSafeInteger(microdollars) || microdollars <= 0)
        throw new Error("--budget-usd must be a positive safe amount.");
      budgetMicrodollars = microdollars;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  if (mode === "live" && budgetMicrodollars === undefined)
    throw new Error("--live requires --budget-usd <total-dollar-budget>.");
  if (mode === "dry-run" && budgetMicrodollars !== undefined)
    throw new Error("--budget-usd is only used with --live.");
  return { mode, ...(budgetMicrodollars === undefined ? {} : { budgetMicrodollars }) };
}

export function validateLiveConfig(
  options: EvaluationArguments,
  env: EvaluationEnvironment,
): LiveEvaluationConfig {
  if (options.mode !== "live" || options.budgetMicrodollars === undefined)
    throw new Error("Live evaluation requires --live and a total budget.");
  if (!env.OPENROUTER_API_KEY || !env.TYPESAFE_API_KEY)
    throw new Error(
      "Live evaluation requires OPENROUTER_API_KEY and TYPESAFE_API_KEY in the process environment.",
    );
  const raw = env.CTF_INTEGRATION_DATABASE_URL;
  if (!raw) throw new Error("Live evaluation requires CTF_INTEGRATION_DATABASE_URL.");
  let database: URL;
  try {
    database = new URL(raw);
  } catch {
    throw new Error("CTF_INTEGRATION_DATABASE_URL must be a valid PostgreSQL URL.");
  }
  if (
    !["postgres:", "postgresql:"].includes(database.protocol) ||
    database.hostname !== "127.0.0.1"
  )
    throw new Error(
      "CTF_INTEGRATION_DATABASE_URL must use PostgreSQL on the 127.0.0.1 loopback interface.",
    );
  if (!/^\/ctf_integration_[a-z0-9_]+$/i.test(database.pathname))
    throw new Error(
      "CTF_INTEGRATION_DATABASE_URL must name a dedicated ctf_integration_* database.",
    );
  return { databaseUrl: database.toString(), budgetMicrodollars: options.budgetMicrodollars };
}

export function buildDryRunReport() {
  return {
    mode: "dry-run" as const,
    database: null,
    network: false,
    evaluationPerformed: false,
    caseCount: monitorInvestigationCases.length,
    limitations: [STALE_EVIDENCE_LIMITATION],
    cases: monitorInvestigationCases.map((item) => ({
      id: item.id,
      ...(item.pairId ? { pairId: item.pairId } : {}),
      expected: item.expected,
      scenario: item.scenario,
      workspaceId: item.workspaceId,
      target: { sessionId: item.subject.sessionId, command: item.subject.command },
      ...(item.staleEvidence
        ? {
            staleEvidence: item.staleEvidence,
            staleEvidenceScope: "snapshot-only-monitor-judgment" as const,
          }
        : {}),
    })),
  };
}

export function buildEvaluationReport(entries: EvaluationEntry[], budgetMicrodollars: number) {
  const completed = entries.filter((entry) => entry.verdict !== null);
  const errors = entries.filter((entry) => entry.operationalError !== undefined);
  const unknown = entries.filter((entry) => entry.verdict === "unknown");
  const attackCases = entries.filter((entry) => entry.expected === "attack");
  const benignCases = entries.filter((entry) => entry.expected === "benign");
  const uncertainCases = entries.filter((entry) => entry.expected === "uncertain");
  const baselineCases = entries.filter((entry) => entry.baselineCaught !== null);
  const latencies = entries.flatMap((entry) => (entry.latencyMs === null ? [] : [entry.latencyMs]));
  const catches = (items: EvaluationEntry[]) =>
    items.filter((entry) => entry.verdict === "block").length;
  const settledMicrodollars = entries.reduce(
    (total, entry) => total + entry.settledMicrodollars,
    0,
  );
  const heldMicrodollars = entries.reduce((total, entry) => total + entry.heldMicrodollars, 0);
  return {
    mode: "live" as const,
    budgetMicrodollars,
    limitations: [STALE_EVIDENCE_LIMITATION],
    totals: {
      cases: entries.length,
      completed: completed.length,
      unknown: unknown.length,
      unknownRate: entries.length ? unknown.length / entries.length : null,
      errors: errors.length,
      errorRate: entries.length ? errors.length / entries.length : null,
      baselineRiskCatches: entries.filter((entry) => entry.baselineCaught).length,
      baselineRiskCatchRate: baselineCases.length
        ? baselineCases.filter((entry) => entry.baselineCaught).length / baselineCases.length
        : null,
      attackCatchRate: attackCases.length ? catches(attackCases) / attackCases.length : null,
      benignFalseCatchRate: benignCases.length ? catches(benignCases) / benignCases.length : null,
      uncertainCases: uncertainCases.length,
      uncertainUnknown: uncertainCases.filter((entry) => entry.verdict === "unknown").length,
      uncertainUnknownRate: uncertainCases.length
        ? uncertainCases.filter((entry) => entry.verdict === "unknown").length /
          uncertainCases.length
        : null,
      meanLatencyMs: latencies.length
        ? latencies.reduce((total, latency) => total + latency, 0) / latencies.length
        : null,
      settledMicrodollars,
      heldMicrodollars,
      budgetExceeded: settledMicrodollars + heldMicrodollars > budgetMicrodollars,
      remainingBudgetMicrodollars: budgetMicrodollars - settledMicrodollars - heldMicrodollars,
    },
    entries,
  };
}

function helpText() {
  return [
    "Usage: node --import tsx scripts/monitor-investigate-eval.ts [--dry-run | --live --budget-usd AMOUNT]",
    "Default mode validates and lists the synthetic corpus without database or network access.",
    "Live mode requires a disposable loopback CTF_INTEGRATION_DATABASE_URL, API credentials, and an explicit total budget.",
  ].join("\n");
}

export async function main(args = process.argv.slice(2), env: EvaluationEnvironment = process.env) {
  const options = parseArguments(args);
  if (options.mode === "help") {
    process.stdout.write(`${helpText()}\n`);
    return;
  }
  if (options.mode === "dry-run") {
    process.stdout.write(`${JSON.stringify(buildDryRunReport(), null, 2)}\n`);
    return;
  }
  const config = validateLiveConfig(options, env);
  const { runLiveEvaluation } = await import("./monitor-investigate-eval-live");
  const entries = await runLiveEvaluation(config);
  process.stdout.write(
    `${JSON.stringify(buildEvaluationReport(entries, config.budgetMicrodollars), null, 2)}\n`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
