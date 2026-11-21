import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArguments, validateLiveConfig } from "../scripts/monitor-investigate-eval";

test("CLI options reject ambiguous budgets and require an explicit live budget", () => {
  assert.deepEqual(parseArguments(["--live", "--budget-usd", "0.125001"]), {
    mode: "live",
    budgetMicrodollars: 125_001,
  });
  assert.throws(() => parseArguments(["--live"]), /requires --budget-usd/);
  assert.throws(() => parseArguments(["--budget-usd", "1"]), /only used with --live/);
  assert.throws(() => parseArguments(["--live", "--budget-usd", "0"]), /positive/);
  assert.throws(() => parseArguments(["--live", "--budget-usd", "1e-3"]), /positive decimal/);
  assert.throws(
    () => parseArguments(["--live", "--budget-usd", "1", "--budget-usd", "2"]),
    /only be supplied once/,
  );
  assert.throws(() => parseArguments(["--unsafe"]), /Unknown option/);
  assert.throws(
    () => parseArguments(["--dry-run", "--live", "--budget-usd", "1"]),
    /cannot be combined/,
  );
  assert.throws(() => parseArguments(["--dry-run", "--dry-run"]), /only be supplied once/);
});

test("live preflight accepts only a loopback ctf_integration database and supplied credentials", () => {
  const options = parseArguments(["--live", "--budget-usd", "0.50"]);
  const env = {
    CTF_INTEGRATION_DATABASE_URL:
      "postgresql://postgres:synthetic@127.0.0.1:5432/ctf_integration_a1b2",
    OPENROUTER_API_KEY: "synthetic-openrouter-key",
  };
  assert.deepEqual(validateLiveConfig(options, env), {
    databaseUrl: env.CTF_INTEGRATION_DATABASE_URL,
    budgetMicrodollars: 500_000,
  });
  for (const override of [
    "host=remote.example",
    "host=%2Ftmp",
    "port=5433",
    "dbname=shared",
    "options=-c%20search_path%3Dpublic",
  ]) {
    assert.throws(
      () =>
        validateLiveConfig(options, {
          ...env,
          CTF_INTEGRATION_DATABASE_URL: `${env.CTF_INTEGRATION_DATABASE_URL}?${override}`,
        }),
      /query|override/,
    );
  }
  assert.throws(
    () =>
      validateLiveConfig(options, {
        ...env,
        CTF_INTEGRATION_DATABASE_URL: "postgresql://remote/ctf_integration_a1b2",
      }),
    /127\.0\.0\.1/,
  );
  assert.throws(
    () =>
      validateLiveConfig(options, {
        ...env,
        CTF_INTEGRATION_DATABASE_URL: "postgresql://127.0.0.1/shared",
      }),
    /ctf_integration_\*/,
  );
  assert.throws(() => {
    const { CTF_INTEGRATION_DATABASE_URL: _databaseUrl, ...withoutDatabase } = env;
    return validateLiveConfig(options, withoutDatabase);
  }, /CTF_INTEGRATION_DATABASE_URL/);
  assert.throws(() => {
    const { OPENROUTER_API_KEY: _openrouterKey, ...withoutOpenrouter } = env;
    return validateLiveConfig(options, withoutOpenrouter);
  }, /OPENROUTER_API_KEY/);
  assert.throws(() => validateLiveConfig({ mode: "dry-run" }, env), /requires --live/);
});
