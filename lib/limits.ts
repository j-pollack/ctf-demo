import type { Pool, PoolClient } from "pg";
import { db } from "./db";
import {
  DAILY_CAP_MICRODOLLARS,
  ENVIRONMENTS_OPEN,
  FINAL_REVIEW_ALLOWANCE_MICRODOLLARS,
  INVESTIGATOR_EFFORT,
  MONITOR_RUN_ALLOWANCE_MICRODOLLARS,
  NAME_CHECKS_PER_DAY,
  PLAYER_AGENT_EFFORT,
  SESSIONS_PER_RUN,
  AUTO_CONTINUE_TURNS,
  RESPONSE_SECONDS,
} from "./policy";
import {
  AGENT_EFFORTS,
  RUNS_PER_DAY,
  RUN_BUDGET_MICRODOLLARS,
  type AgentEffort,
  type Limits,
  type PlayerLimits,
} from "./types";

// Read by the monitor worker, which has no auth secret: keep lib/auth out of this import chain.
// This file imports only db, policy and types, so policy can never reach it through a cycle.
type ChoiceField = "agentEffort" | "investigatorEffort";
type NumberDefinition = {
  key: string;
  field: Exclude<keyof Limits, ChoiceField>;
  default: number;
  min: number;
  max: number;
  kind: "money" | "count";
};
type ChoiceDefinition = {
  key: string;
  field: ChoiceField;
  default: AgentEffort;
  options: readonly AgentEffort[];
  kind: "choice";
};
type LimitDefinition = NumberDefinition | ChoiceDefinition;
type Env = Readonly<Record<string, string | undefined>>;

// Bounds are fixed in code so a form typo cannot remove a spending limit.
export const LIMITS = [
  {
    key: "daily_cap_microdollars",
    field: "dailyCapMicrodollars",
    default: DAILY_CAP_MICRODOLLARS,
    min: 0,
    max: 100_000_000,
    kind: "money",
  },
  {
    key: "run_budget_microdollars",
    field: "runBudgetMicrodollars",
    default: RUN_BUDGET_MICRODOLLARS,
    min: 10_000,
    max: 5_000_000,
    kind: "money",
  },
  {
    key: "runs_per_day",
    field: "runsPerDay",
    default: RUNS_PER_DAY,
    min: 1,
    max: 50,
    kind: "count",
  },
  {
    key: "total_runs_per_day",
    field: "totalRunsPerDay",
    default: 100,
    min: 0,
    max: 10_000,
    kind: "count",
  },
  {
    key: "monitor_run_allowance_microdollars",
    field: "monitorRunAllowanceMicrodollars",
    default: MONITOR_RUN_ALLOWANCE_MICRODOLLARS,
    min: 100_000,
    max: 10_000_000,
    kind: "money",
  },
  {
    key: "final_review_allowance_microdollars",
    field: "finalReviewAllowanceMicrodollars",
    default: FINAL_REVIEW_ALLOWANCE_MICRODOLLARS,
    min: 0,
    max: 10_000_000,
    kind: "money",
  },
  {
    key: "environments_open",
    field: "environmentsOpen",
    default: ENVIRONMENTS_OPEN,
    min: 1,
    max: 50,
    kind: "count",
  },
  {
    key: "name_checks_per_day",
    field: "nameChecksPerDay",
    default: NAME_CHECKS_PER_DAY,
    min: 1,
    max: 200,
    kind: "count",
  },
  {
    key: "sessions_per_run",
    field: "sessionsPerRun",
    default: SESSIONS_PER_RUN,
    min: 1,
    max: 32,
    kind: "count",
  },
  {
    key: "auto_continue_turns",
    field: "autoContinueTurns",
    default: AUTO_CONTINUE_TURNS,
    min: 0,
    max: 50,
    kind: "count",
  },
  // The maximum leaves 40 seconds before the 270 second session lease in lib/sessions.ts and 70
  // before the prompt route's maxDuration. Raise those first, never this alone.
  {
    key: "response_seconds",
    field: "responseSeconds",
    default: RESPONSE_SECONDS,
    min: 5,
    max: 230,
    kind: "count",
  },
  {
    key: "agent_effort",
    field: "agentEffort",
    default: PLAYER_AGENT_EFFORT,
    options: AGENT_EFFORTS,
    kind: "choice",
  },
  {
    key: "investigator_effort",
    field: "investigatorEffort",
    default: INVESTIGATOR_EFFORT,
    options: AGENT_EFFORTS,
    kind: "choice",
  },
] as const satisfies readonly LimitDefinition[];

export type LimitKey = (typeof LIMITS)[number]["key"];
export const LIMIT_KEYS = LIMITS.map((limit) => limit.key);
export const DEFAULT_LIMITS = Object.fromEntries(
  LIMITS.map((limit) => [limit.field, limit.default]),
) as Limits;

const limitOf = (key: unknown): LimitDefinition | undefined =>
  LIMITS.find((limit) => limit.key === key);
const inBounds = (limit: NumberDefinition, value: number) =>
  value >= limit.min && value <= limit.max;
const MICRODOLLARS_PER_DOLLAR = 1_000_000;
const MICRODOLLARS_PER_CENT = 10_000;

// A value in the stored format: whole microdollars, a whole count or an effort word. The
// environment uses the same format. Undefined when it is not valid for the limit.
function readStored(limit: LimitDefinition, value: string) {
  if (limit.kind === "choice") return limit.options.find((option) => option === value);
  if (!/^(0|[1-9]\d*)$/.test(value)) return undefined;
  const number = Number(value);
  return inBounds(limit, number) ? number : undefined;
}

export function parseStoredLimit(key: LimitKey, value: string) {
  const limit = limitOf(key)!;
  return readStored(limit, value) ?? limit.default;
}

// The admin form's value: dollars for money, a whole number for counts, an option for choices.
// Money is read from the string, not multiplied, so 2.01 is exactly 2,010,000 microdollars.
// Null when it is not valid.
export function parseLimitInput(key: unknown, value: unknown) {
  const limit = limitOf(key);
  if (!limit || typeof value !== "string") return null;
  if (limit.kind === "choice") return limit.options.find((option) => option === value) ?? null;
  const parsed = limit.kind === "count" ? parseCount(value) : parseDollars(value);
  return parsed !== null && inBounds(limit, parsed) ? parsed : null;
}

const parseCount = (value: string) => (/^\d+$/.test(value) ? Number(value) : null);

function parseDollars(value: string) {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) return null;
  const cents = Number((match[2] ?? "").padEnd(2, "0"));
  return Number(match[1]) * MICRODOLLARS_PER_DOLLAR + cents * MICRODOLLARS_PER_CENT;
}

export const limitEnvName = (key: LimitKey) => `CTF_${key.toUpperCase()}`;

// The deploy-level layer under the stored settings: the missing variables and the invalid ones.
export function limitEnvProblems(env: Env) {
  const missing: string[] = [];
  const invalid: string[] = [];
  for (const limit of LIMITS) {
    const name = limitEnvName(limit.key);
    const value = env[name];
    if (value === undefined || value === "") missing.push(name);
    else if (readStored(limit, value) === undefined) invalid.push(name);
  }
  return { missing, invalid };
}

// A valid stored value, else a valid environment value, else the code default. Pure, so the
// order is tested without a database.
export function resolveLimits(stored: Readonly<Record<string, string>>, env: Env) {
  return Object.fromEntries(
    LIMITS.map((limit) => {
      const fromStore = stored[limit.key];
      const fromEnv = env[limitEnvName(limit.key)];
      const value =
        (fromStore === undefined ? undefined : readStored(limit, fromStore)) ??
        (fromEnv === undefined ? undefined : readStored(limit, fromEnv)) ??
        limit.default;
      return [limit.field, value];
    }),
  ) as Limits;
}

// The environment and the defaults with no database read, for a page the database cannot serve.
export const fallbackLimits = (env: Env) => resolveLimits({}, env);

export const playerLimits = (limits: Limits): PlayerLimits => ({
  runBudgetMicrodollars: limits.runBudgetMicrodollars,
  runsPerDay: limits.runsPerDay,
  dailyCapMicrodollars: limits.dailyCapMicrodollars,
  sessionsPerRun: limits.sessionsPerRun,
  autoContinueTurns: limits.autoContinueTurns,
});

// A missing table is not tolerated: a failed statement would abort the caller's transaction.
// Nor is a failed read caught: only the page components fall back, so nothing else acts on
// environment values silently.
export async function currentLimits(queryable: Pick<Pool | PoolClient, "query"> = db) {
  const { rows } = await queryable.query<{ key: LimitKey; value: string }>(
    "SELECT key,value FROM ctf.settings WHERE key=ANY($1)",
    [LIMIT_KEYS],
  );
  return resolveLimits(Object.fromEntries(rows.map((row) => [row.key, row.value])), process.env);
}
