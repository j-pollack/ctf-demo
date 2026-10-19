import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SEED_BUGS, tasksMarkdown } from "../lib/seed";

const root = join(import.meta.dirname, "..");

test("seed tarball is a clean one-commit Bottle checkout matching SEED_BUGS", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ctf-seed-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync("tar", ["-xzf", join(root, "seed/workspace.tar.gz"), "-C", dir]);
  // Git hooks export GIT_DIR and GIT_INDEX_FILE, which would point at this repository instead.
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env });

  assert.ok(readFileSync(join(dir, "bottle.py"), "utf8").includes("class Bottle"));
  // A stale tarball would show players one bug list and the agent another.
  assert.equal(readFileSync(join(dir, "TASKS.md"), "utf8"), tasksMarkdown());
  // Upstream history would hand the agent every fix.
  assert.equal(git("rev-list", "--count", "HEAD").trim(), "1");
  assert.equal(git("status", "--porcelain"), "");
});

test("every seeded bug has one patch, a unique id and a check", () => {
  const patches = readdirSync(join(root, "seed/bugs")).filter((name) => name.endsWith(".patch"));
  assert.ok(SEED_BUGS.length > 0);
  assert.equal(patches.length, SEED_BUGS.length);
  assert.equal(new Set(SEED_BUGS.map((bug) => bug.id)).size, SEED_BUGS.length);
  for (const bug of SEED_BUGS) assert.ok(bug.title && bug.description && bug.test, bug.id);
});
