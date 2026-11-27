import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { LIMITS, limitEnvName } from "../lib/limits";
import { deployEnvProblems, shouldMigrate } from "../scripts/vercel-build";

const own = "postgres://u:p@ep-own-branch-123.c-4.us-west-2.aws.neon.tech/neondb";
const shared = "postgres://u:p@ep-wild-bird-arrztsd4.c-4.us-west-2.aws.neon.tech/neondb";
const sharedPooled =
  "postgres://u:p@ep-wild-bird-arrztsd4-pooler.c-4.us-west-2.aws.neon.tech/neondb";

test("only previews on their own Neon branch migrate at build", () => {
  assert.equal(shouldMigrate({ VERCEL_ENV: "production", DATABASE_URL_UNPOOLED: own }), false);
  assert.equal(shouldMigrate({ VERCEL_ENV: "development", DATABASE_URL: shared }), false);
  assert.equal(shouldMigrate({ DATABASE_URL: own }), false);
  assert.equal(shouldMigrate({ VERCEL_ENV: "preview", DATABASE_URL_UNPOOLED: own }), true);
  // The unpooled URL is what setup connects to, so it decides.
  assert.equal(
    shouldMigrate({
      VERCEL_ENV: "preview",
      DATABASE_URL_UNPOOLED: own,
      DATABASE_URL: sharedPooled,
    }),
    true,
  );
  assert.throws(
    () => shouldMigrate({ VERCEL_ENV: "preview", DATABASE_URL_UNPOOLED: shared }),
    /shared vercel-dev/,
  );
  assert.throws(
    () => shouldMigrate({ VERCEL_ENV: "preview", DATABASE_URL: sharedPooled }),
    /shared vercel-dev/,
  );
  assert.throws(() => shouldMigrate({ VERCEL_ENV: "preview" }), /no database URL/);
});

const limitEnv = (): Record<string, string> =>
  Object.fromEntries(LIMITS.map((limit) => [limitEnvName(limit.key), String(limit.default)]));

test("only a production or preview deploy checks the thirteen variables", () => {
  const none = { missing: [], invalid: [] };
  assert.deepEqual(deployEnvProblems({}), none);
  assert.deepEqual(deployEnvProblems({ VERCEL_ENV: "development" }), none);
  for (const VERCEL_ENV of ["production", "preview"]) {
    assert.equal(deployEnvProblems({ VERCEL_ENV }).missing.length, 13, VERCEL_ENV);
    assert.deepEqual(deployEnvProblems({ VERCEL_ENV, ...limitEnv() }), none, VERCEL_ENV);
    assert.deepEqual(
      deployEnvProblems({ VERCEL_ENV, ...limitEnv(), CTF_AGENT_EFFORT: "max" }).invalid,
      ["CTF_AGENT_EFFORT"],
    );
    for (const value of ["4", "231", "5.5"])
      assert.deepEqual(
        deployEnvProblems({ VERCEL_ENV, ...limitEnv(), CTF_RESPONSE_SECONDS: value }).invalid,
        ["CTF_RESPONSE_SECONDS"],
        value,
      );
    const { CTF_RESPONSE_SECONDS: _omitted, ...without } = limitEnv();
    assert.deepEqual(
      deployEnvProblems({ VERCEL_ENV, ...without }).missing,
      ["CTF_RESPONSE_SECONDS"],
      VERCEL_ENV,
    );
  }
});

// A clean environment, so neither this shell nor the worktree's .env.local leaks in.
const build = (env: Record<string, string>) =>
  spawnSync(process.execPath, ["--import", "tsx", "scripts/vercel-build.ts"], {
    cwd: new URL("..", import.meta.url),
    env: { PATH: process.env.PATH ?? "", NODE_ENV: "test", ...env },
    encoding: "utf8",
  });

test("the build script names every missing and invalid variable before it does anything else", () => {
  const env: Record<string, string> = { ...limitEnv(), VERCEL_ENV: "preview" };
  delete env.CTF_RUNS_PER_DAY;
  env.CTF_ENVIRONMENTS_OPEN = "0";
  const result = build(env);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CTF_RUNS_PER_DAY/);
  assert.match(result.stderr, /CTF_ENVIRONMENTS_OPEN/);
  assert.doesNotMatch(result.stderr, /no database URL/);
});

test("with all thirteen valid the build script goes on to the database check", () => {
  const result = build({ ...limitEnv(), VERCEL_ENV: "preview" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Preview has no database URL/);
  assert.doesNotMatch(result.stderr, /CTF_/);
});
