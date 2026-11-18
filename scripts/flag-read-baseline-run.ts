import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { baselineSources } from "./flag-read-baseline-files";
import {
  buildSchedule,
  parseBaselineStrategy,
  parseBaselineSplit,
  selectBaseline,
  summarizeBaseline,
  type BaselineStrategy,
  type BaselineSplit,
} from "./flag-read-baseline";
import { toFlagReadCase } from "./flag-read-corpus";
import type { FlagReadEntry } from "./flag-read-eval";
import {
  parseArguments,
  validateLiveConfig,
  type EvaluationEnvironment,
} from "./monitor-investigate-eval";

export function prepareBaseline(
  corpus: string,
  schedule: unknown,
  sources: Record<string, string>,
  budget?: number,
  strategy: BaselineStrategy = "closed-world-presumption",
  split: BaselineSplit = "dev",
) {
  const expected = buildSchedule(corpus, sources, strategy, split);
  if (!isDeepStrictEqual(schedule, expected))
    throw new Error(
      "Frozen baseline schedule differs from corpus, sources or runtime policy. Regenerate and review it before execution.",
    );
  if (
    budget !== undefined &&
    (!Number.isSafeInteger(budget) || budget <= 0 || budget > expected.budget.proposedMicrodollars)
  )
    throw new Error(
      "Budget must be a positive integer number of microdollars at or below the frozen proposal.",
    );
  return {
    schedule: expected,
    cases: selectBaseline(JSON.parse(corpus), split).map((item) => toFlagReadCase(item, "strict")),
  };
}

export async function main(args = process.argv.slice(2), env: EvaluationEnvironment = process.env) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  if (realpathSync(process.cwd()) !== realpathSync(root))
    throw new Error("Run the baseline runner from its own checkout directory.");
  const selections = new Map<string, string>();
  const evaluationArgs: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (!["--output-dir", "--strategy", "--schedule", "--split"].includes(option)) {
      evaluationArgs.push(args[index]);
      continue;
    }
    if (selections.has(option) || !args[index + 1] || args[index + 1].startsWith("--"))
      throw new Error(`Supply ${option} once with a value.`);
    selections.set(option, args[++index]);
  }
  const options = parseArguments(evaluationArgs);
  if (options.mode === "help") {
    if (selections.size) throw new Error("--help cannot be combined with other options.");
    console.log(
      "Usage: node --import tsx scripts/flag-read-baseline-run.ts [--dry-run | --live --budget-usd AMOUNT --output-dir NEW_DIRECTORY] [--strategy closed-world-presumption] --schedule FILE [--split dev|test]. A schedule file is required.",
    );
    return;
  }
  const strategy = parseBaselineStrategy(
    selections.get("--strategy") ?? "closed-world-presumption",
  );
  const split = parseBaselineSplit(selections.get("--split") ?? "dev");
  const schedulePath = selections.get("--schedule");
  if (!schedulePath) throw new Error("An explicit --schedule FILE is required.");
  const output = selections.get("--output-dir");
  if ((options.mode === "live") !== Boolean(output))
    throw new Error("Only live mode requires --output-dir NEW_DIRECTORY.");
  const corpus = readFileSync("evals/flag-read/cases.json", "utf8");
  const scheduleText = readFileSync(schedulePath, "utf8");
  const prepared = prepareBaseline(
    corpus,
    JSON.parse(scheduleText),
    baselineSources(),
    options.budgetMicrodollars,
    strategy,
    split,
  );
  if (options.mode === "dry-run") {
    console.log(
      JSON.stringify(
        {
          mode: "dry-run",
          evaluationPerformed: false,
          cases: prepared.cases.length,
          strategy,
          split,
          promptHash: prepared.schedule.policy.promptHash,
          scheduleSha256: createHash("sha256").update(scheduleText).digest("hex"),
        },
        null,
        2,
      ),
    );
    return;
  }
  const config = validateLiveConfig(options, env);
  // Must create a fresh directory: prior runs are never overwritten or silently resumed.
  const directory = resolve(output!);
  mkdirSync(directory);
  const write = (name: string, value: unknown) =>
    writeFileSync(join(directory, name), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  write("schedule.json", prepared.schedule);
  write("run.json", {
    startedAt: new Date().toISOString(),
    scheduleSha256: createHash("sha256").update(scheduleText).digest("hex"),
    budgetMicrodollars: config.budgetMicrodollars,
    database: new URL(config.databaseUrl).pathname,
    evaluationPerformed: true,
  });
  const journal = openSync(join(directory, "entries.jsonl"), "wx");
  const entries: FlagReadEntry[] = [];
  let terminal = false;
  const persist = (status: string) => {
    if (terminal) return;
    write("summary.json", {
      status,
      budgetMicrodollars: config.budgetMicrodollars,
      accountingComplete: entries.length === prepared.cases.length,
      accountingNote:
        "Totals cover persisted case entries only. An interrupted/fatal in-flight case may have additional charges or holds in the run database; retain that database for reconciliation. Held costs remain unresolved.",
      ...summarizeBaseline(corpus, entries, prepared.schedule),
    });
    terminal = true;
  };
  const interrupted = (signal: "SIGINT" | "SIGTERM") => {
    persist(`interrupted:${signal}`);
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  const onInterrupt = () => interrupted("SIGINT");
  const onTerminate = () => interrupted("SIGTERM");
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  try {
    const { runFlagReadLiveEvaluation } = await import("./flag-read-eval-live");
    await runFlagReadLiveEvaluation(config, prepared.cases, undefined, {
      searchStrategy: strategy,
      onEntry: (entry) => {
        // Stop before another case if serialization or disk persistence fails.
        writeFileSync(journal, `${JSON.stringify(entry)}\n`);
        fsyncSync(journal);
        entries.push(entry);
      },
    });
    persist(
      entries.some((entry) => entry.accountingOverrun) ? "stopped:accounting-overrun" : "completed",
    );
    return summarizeBaseline(corpus, entries, prepared.schedule);
  } catch (error) {
    persist("failed");
    throw error;
  } finally {
    closeSync(journal);
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
