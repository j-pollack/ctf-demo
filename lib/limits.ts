import type { Pool, PoolClient } from "pg";
import { db } from "./db";
import {
  DAILY_CAP_MICRODOLLARS,
  FINAL_REVIEW_ALLOWANCE_MICRODOLLARS,
  MONITOR_RUN_ALLOWANCE_MICRODOLLARS,
} from "./policy";
import { RUNS_PER_DAY, RUN_BUDGET_MICRODOLLARS, type Limits } from "./types";

// Read by the monitor worker, which has no auth secret: keep lib/auth out of this import chain.
type LimitDefinition = {
  key: string;
  field: keyof Limits;
  default: number;
  min: number;
  max: number;
  kind: "money" | "count";
};

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
] as const satisfies readonly LimitDefinition[];

export type LimitKey = (typeof LIMITS)[number]["key"];
export const LIMIT_KEYS = LIMITS.map((limit) => limit.key);
export const DEFAULT_LIMITS = Object.fromEntries(
  LIMITS.map((limit) => [limit.field, limit.default]),
) as Limits;

const limitOf = (key: unknown) => LIMITS.find((limit) => limit.key === key);
const inBounds = (limit: LimitDefinition, value: number) =>
  value >= limit.min && value <= limit.max;
const MICRODOLLARS_PER_DOLLAR = 1_000_000;
const MICRODOLLARS_PER_CENT = 10_000;

export function parseStoredLimit(key: LimitKey, value: string) {
  const limit = limitOf(key)!;
  if (!/^(0|[1-9]\d*)$/.test(value)) return limit.default;
  const number = Number(value);
  return inBounds(limit, number) ? number : limit.default;
}

// The admin form's value: dollars for money, a whole number for counts. Money is read from the
// string, not multiplied, so 2.01 is exactly 2,010,000 microdollars. Null when it is not valid.
export function parseLimitInput(key: unknown, value: unknown) {
  const limit = limitOf(key);
  if (!limit || typeof value !== "string") return null;
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

// A missing table is not tolerated: a failed statement would abort the caller's transaction.
export async function currentLimits(queryable: Pick<Pool | PoolClient, "query"> = db) {
  const { rows } = await queryable.query<{ key: LimitKey; value: string }>(
    "SELECT key,value FROM ctf.settings WHERE key=ANY($1)",
    [LIMIT_KEYS],
  );
  const stored = new Map(rows.map((row) => [row.key, row.value]));
  return Object.fromEntries(
    LIMITS.map((limit) => {
      const value = stored.get(limit.key);
      return [
        limit.field,
        value === undefined ? limit.default : parseStoredLimit(limit.key, value),
      ];
    }),
  ) as Limits;
}
