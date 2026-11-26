import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LIMITS, LIMITS, parseLimitInput, parseStoredLimit } from "../lib/limits";
import {
  DAILY_CAP_MICRODOLLARS,
  FINAL_REVIEW_ALLOWANCE_MICRODOLLARS,
  MONITOR_RUN_ALLOWANCE_MICRODOLLARS,
} from "../lib/policy";
import { RUNS_PER_DAY, RUN_BUDGET_MICRODOLLARS } from "../lib/types";

test("the defaults are the existing constants and the literal total", () => {
  assert.deepEqual(DEFAULT_LIMITS, {
    dailyCapMicrodollars: DAILY_CAP_MICRODOLLARS,
    runBudgetMicrodollars: RUN_BUDGET_MICRODOLLARS,
    runsPerDay: RUNS_PER_DAY,
    totalRunsPerDay: 100,
    monitorRunAllowanceMicrodollars: MONITOR_RUN_ALLOWANCE_MICRODOLLARS,
    finalReviewAllowanceMicrodollars: FINAL_REVIEW_ALLOWANCE_MICRODOLLARS,
  });
  for (const limit of LIMITS) {
    assert.ok(limit.min <= limit.default && limit.default <= limit.max, limit.key);
  }
});

test("a stored value is used only when it is a canonical integer inside the bounds", () => {
  const key = "runs_per_day";
  assert.equal(parseStoredLimit(key, "7"), 7);
  assert.equal(parseStoredLimit(key, "1"), 1);
  assert.equal(parseStoredLimit(key, "50"), 50);
  for (const bad of ["", "0", "51", "07", "+7", "-1", "7.0", "7.5", " 7", "7 ", "1e1", "abc", "٣"])
    assert.equal(parseStoredLimit(key, bad), DEFAULT_LIMITS.runsPerDay, JSON.stringify(bad));
  assert.equal(parseStoredLimit("daily_cap_microdollars", "0"), 0);
  assert.equal(parseStoredLimit("daily_cap_microdollars", "100000000"), 100_000_000);
  assert.equal(
    parseStoredLimit("daily_cap_microdollars", "100000001"),
    DEFAULT_LIMITS.dailyCapMicrodollars,
  );
  assert.equal(
    parseStoredLimit("run_budget_microdollars", "9999"),
    DEFAULT_LIMITS.runBudgetMicrodollars,
  );
  assert.equal(parseStoredLimit("run_budget_microdollars", "10000"), 10_000);
  assert.equal(
    parseStoredLimit("monitor_run_allowance_microdollars", "0"),
    DEFAULT_LIMITS.monitorRunAllowanceMicrodollars,
  );
  assert.equal(parseStoredLimit("final_review_allowance_microdollars", "0"), 0);
  assert.equal(parseStoredLimit("total_runs_per_day", "10000"), 10_000);
  assert.equal(parseStoredLimit("total_runs_per_day", "99999999999999999999"), 100);
});

test("money is entered in dollars and converted from the string", () => {
  const cap = "daily_cap_microdollars";
  assert.equal(parseLimitInput(cap, "10"), 10_000_000);
  assert.equal(parseLimitInput(cap, "0.5"), 500_000);
  assert.equal(parseLimitInput(cap, "0.50"), 500_000);
  assert.equal(parseLimitInput(cap, "2.01"), 2_010_000);
  assert.equal(parseLimitInput(cap, "0"), 0);
  assert.equal(parseLimitInput(cap, "100"), 100_000_000);
  assert.equal(parseLimitInput("run_budget_microdollars", "0.01"), 10_000);
  for (const bad of [".5", "10.", "1e1", "1.234", "-1", "", " 1", "1 ", "1,5", "101", "100.01"])
    assert.equal(parseLimitInput(cap, bad), null, JSON.stringify(bad));
  assert.equal(parseLimitInput("run_budget_microdollars", "0.00"), null);
  assert.equal(parseLimitInput("run_budget_microdollars", "5.01"), null);
  assert.equal(parseLimitInput("monitor_run_allowance_microdollars", "0.09"), null);
  assert.equal(parseLimitInput("monitor_run_allowance_microdollars", "0.1"), 100_000);
});

test("counts are whole numbers inside the bounds", () => {
  assert.equal(parseLimitInput("runs_per_day", "3"), 3);
  assert.equal(parseLimitInput("runs_per_day", "50"), 50);
  assert.equal(parseLimitInput("total_runs_per_day", "0"), 0);
  assert.equal(parseLimitInput("total_runs_per_day", "10000"), 10_000);
  for (const bad of ["3.0", "3.5", "-1", "", "1e1", "0", "51", " 3", "3."])
    assert.equal(parseLimitInput("runs_per_day", bad), null, JSON.stringify(bad));
  assert.equal(parseLimitInput("total_runs_per_day", "10001"), null);
});

test("a non-string value or unknown key is not a limit", () => {
  assert.equal(parseLimitInput("runs_per_day", 3), null);
  assert.equal(parseLimitInput("runs_per_day", null), null);
  assert.equal(parseLimitInput("runs_per_day", undefined), null);
  assert.equal(parseLimitInput("nope", "3"), null);
  assert.equal(parseLimitInput(7, "3"), null);
});
