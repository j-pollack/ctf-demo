import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_LIMITS,
  LIMITS,
  fallbackLimits,
  limitEnvName,
  limitEnvProblems,
  parseLimitInput,
  parseStoredLimit,
  playerLimits,
  resolveLimits,
} from "../lib/limits";
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
    environmentsOpen: 10,
    nameChecksPerDay: 20,
    sessionsPerRun: 8,
    autoContinueTurns: 8,
    responseSeconds: 230,
    agentEffort: "low",
    investigatorEffort: "high",
  });
  assert.equal(LIMITS.length, 13);
  for (const limit of LIMITS) {
    if (limit.kind === "choice") assert.ok(limit.options.includes(limit.default), limit.key);
    else assert.ok(limit.min <= limit.default && limit.default <= limit.max, limit.key);
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

const allSet = () =>
  Object.fromEntries(LIMITS.map((limit) => [limitEnvName(limit.key), String(limit.default)]));

test("the new counts have their bounds", () => {
  const bounds: [Parameters<typeof parseLimitInput>[0], string, number | null][] = [
    ["environments_open", "1", 1],
    ["environments_open", "50", 50],
    ["environments_open", "0", null],
    ["environments_open", "51", null],
    ["name_checks_per_day", "200", 200],
    ["name_checks_per_day", "201", null],
    ["name_checks_per_day", "0", null],
    ["sessions_per_run", "32", 32],
    ["sessions_per_run", "33", null],
    ["sessions_per_run", "0", null],
    ["auto_continue_turns", "0", 0],
    ["auto_continue_turns", "50", 50],
    ["auto_continue_turns", "51", null],
    ["response_seconds", "5", 5],
    ["response_seconds", "230", 230],
    ["response_seconds", "4", null],
    ["response_seconds", "231", null],
    ["response_seconds", "5.5", null],
    ["response_seconds", "abc", null],
  ];
  for (const [key, value, expected] of bounds)
    assert.equal(parseLimitInput(key, value), expected, `${key} ${value}`);
});

test("a choice is valid only when it is one of the options", () => {
  for (const key of ["agent_effort", "investigator_effort"] as const) {
    for (const option of ["low", "medium", "high"]) {
      assert.equal(parseLimitInput(key, option), option);
      assert.equal(parseStoredLimit(key, option), option);
    }
    for (const bad of ["", "Low", "HIGH", " low", "low ", "max", "1", "toString"]) {
      assert.equal(parseLimitInput(key, bad), null, JSON.stringify(bad));
    }
    assert.equal(parseLimitInput(key, 1), null);
    assert.equal(parseLimitInput(key, undefined), null);
  }
  assert.equal(parseStoredLimit("agent_effort", "max"), DEFAULT_LIMITS.agentEffort);
  assert.equal(parseStoredLimit("investigator_effort", ""), DEFAULT_LIMITS.investigatorEffort);
});

test("an environment name is CTF_ and the key in upper case", () => {
  assert.equal(limitEnvName("daily_cap_microdollars"), "CTF_DAILY_CAP_MICRODOLLARS");
  assert.equal(limitEnvName("agent_effort"), "CTF_AGENT_EFFORT");
});

test("a stored value wins, then the environment, then the default", () => {
  const env = { CTF_RUNS_PER_DAY: "5", CTF_AGENT_EFFORT: "high", CTF_RUN_BUDGET_MICRODOLLARS: "x" };
  assert.deepEqual(resolveLimits({}, {}), DEFAULT_LIMITS);
  const fromEnv = resolveLimits({}, env);
  assert.equal(fromEnv.runsPerDay, 5);
  assert.equal(fromEnv.agentEffort, "high");
  assert.equal(
    fromEnv.runBudgetMicrodollars,
    DEFAULT_LIMITS.runBudgetMicrodollars,
    "an invalid environment value gives the default",
  );
  const stored = resolveLimits({ runs_per_day: "7", agent_effort: "medium" }, env);
  assert.equal(stored.runsPerDay, 7);
  assert.equal(stored.agentEffort, "medium");
  const invalidStored = resolveLimits({ runs_per_day: "0", agent_effort: "max" }, env);
  assert.equal(invalidStored.runsPerDay, 5, "an invalid stored value falls to the environment");
  assert.equal(invalidStored.agentEffort, "high");
  const bothInvalid = resolveLimits({ runs_per_day: "0" }, { CTF_RUNS_PER_DAY: "99" });
  assert.equal(bothInvalid.runsPerDay, DEFAULT_LIMITS.runsPerDay);
});

test("the response time limit resolves from a stored value, then the environment, then 230", () => {
  assert.equal(resolveLimits({}, {}).responseSeconds, 230);
  for (const stored of ["5", "60", "230"])
    assert.equal(resolveLimits({ response_seconds: stored }, {}).responseSeconds, Number(stored));
  const env = { CTF_RESPONSE_SECONDS: "90" };
  assert.equal(resolveLimits({ response_seconds: "60" }, env).responseSeconds, 60);
  for (const bad of ["4", "231", "5.5", "abc"]) {
    assert.equal(resolveLimits({ response_seconds: bad }, env).responseSeconds, 90, bad);
    assert.equal(resolveLimits({ response_seconds: bad }, {}).responseSeconds, 230, bad);
  }
});

test("fallbackLimits reads the environment passed to it at call time", () => {
  assert.deepEqual(fallbackLimits({}), DEFAULT_LIMITS);
  assert.equal(fallbackLimits({ CTF_NAME_CHECKS_PER_DAY: "30" }).nameChecksPerDay, 30);
  assert.equal(fallbackLimits({ CTF_NAME_CHECKS_PER_DAY: "30.5" }).nameChecksPerDay, 20);
  assert.equal(fallbackLimits({ CTF_INVESTIGATOR_EFFORT: "low" }).investigatorEffort, "low");
});

test("environment problems list each missing and each invalid name", () => {
  assert.deepEqual(limitEnvProblems(allSet()), { missing: [], invalid: [] });
  const env: Record<string, string | undefined> = allSet();
  delete env.CTF_RUNS_PER_DAY;
  env.CTF_SESSIONS_PER_RUN = "";
  env.CTF_DAILY_CAP_MICRODOLLARS = "10.5";
  env.CTF_AGENT_EFFORT = "max";
  env.CTF_TOTAL_RUNS_PER_DAY = "10001";
  assert.deepEqual(limitEnvProblems(env), {
    missing: ["CTF_RUNS_PER_DAY", "CTF_SESSIONS_PER_RUN"],
    invalid: ["CTF_DAILY_CAP_MICRODOLLARS", "CTF_TOTAL_RUNS_PER_DAY", "CTF_AGENT_EFFORT"],
  });
  assert.equal(limitEnvProblems({}).missing.length, 13);
});

test("the player limits are exactly the five values the browser uses", () => {
  const limits = playerLimits({ ...DEFAULT_LIMITS, totalRunsPerDay: 5, agentEffort: "high" });
  assert.deepEqual(Object.keys(limits).sort(), [
    "autoContinueTurns",
    "dailyCapMicrodollars",
    "runBudgetMicrodollars",
    "runsPerDay",
    "sessionsPerRun",
  ]);
  assert.equal(limits.sessionsPerRun, 8);
});

test(".env.example lists the thirteen variables at their defaults and passes the check", () => {
  const values = Object.fromEntries(
    readFileSync(new URL("../.env.example", import.meta.url), "utf8")
      .split("\n")
      .filter((line) => /^[A-Z0-9_]+=/.test(line))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  assert.deepEqual(limitEnvProblems(values), { missing: [], invalid: [] });
  assert.deepEqual(fallbackLimits(values), DEFAULT_LIMITS);
});
