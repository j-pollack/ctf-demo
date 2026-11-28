import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { LIMITS, limitEnvName } from "../lib/limits";

const NAMES = LIMITS.map((limit) => limitEnvName(limit.key));
const run = (input: string) =>
  spawnSync(process.execPath, ["--import", "tsx", "scripts/check-limit-env.ts"], {
    cwd: new URL("..", import.meta.url),
    env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" },
    input,
    encoding: "utf8",
  });
const table = (names: string[]) =>
  [
    "NAME                              DIGEST            CREATED AT",
    "OPENROUTER_API_KEY                0123456789abcdef  1d ago",
    ...names.map((name) => `${name.padEnd(34)}fedcba9876543210  2h ago`),
  ].join("\n");

test("all thirteen names present in table text pass", () => {
  const result = run(table(NAMES));
  assert.equal(result.status, 0, result.stderr);
});

test("a missing name is printed and fails", () => {
  const result = run(table(NAMES.filter((name) => name !== "CTF_AGENT_EFFORT")));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^CTF_AGENT_EFFORT$/m);
  assert.equal(result.stdout.trim().split("\n").length, 1);
});

test("a missing response time limit is named", () => {
  const result = run(table(NAMES.filter((name) => name !== "CTF_RESPONSE_SECONDS")));
  assert.equal(result.status, 1);
  assert.equal(result.stdout.trim(), "CTF_RESPONSE_SECONDS");
});

test("a name inside a longer name does not count", () => {
  const result = run(table(NAMES.filter((name) => name !== "CTF_RUNS_PER_DAY")));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^CTF_RUNS_PER_DAY$/m);
  assert.doesNotMatch(result.stdout, /TOTAL/);
});

test("JSON-style punctuation around the names still counts", () => {
  const json = JSON.stringify(NAMES.map((Name) => ({ Name })));
  assert.equal(run(json).status, 0);
});

test("empty input fails", () => {
  for (const input of ["", "\n", "   "]) {
    const result = run(input);
    assert.equal(result.status, 1);
    assert.match(result.stdout + result.stderr, /CTF_/);
  }
});
