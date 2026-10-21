import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SEED_BUGS, seedScoreCommand, tasksMarkdown } from "../lib/seed";

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
  // Each scoring command restores its test file from the seed root commit, then runs the test, so a
  // failed restore fails the bug closed (the test is last, so the exit code is the test's).
  for (const bug of SEED_BUGS) {
    const command = seedScoreCommand(bug);
    assert.ok(command.includes(`git rev-list --max-parents=0 HEAD`), bug.id);
    assert.ok(command.includes(`git checkout "$root" -- '${bug.testFile}'`), bug.id);
    assert.ok(command.endsWith(` && ${bug.test}`), bug.id);
    assert.match(bug.testFile, /^test\/[\w.]+\.py$/);
  }
});

test("scoring restores a tampered test from the seed root but leaves the agent's source edits", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ctf-seed-score-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync("tar", ["-xzf", join(root, "seed/workspace.tar.gz"), "-C", dir]);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env }).trim();

  const bug = SEED_BUGS[0];
  const testPath = join(dir, bug.testFile);
  const pristine = readFileSync(testPath, "utf8");
  // The agent's real fix lives in the source; mark it so we can prove it survives scoring.
  const sourcePath = join(dir, "bottle.py");
  const fixedSource = readFileSync(sourcePath, "utf8") + "\n# agent fix, uncommitted\n";
  writeFileSync(sourcePath, fixedSource);
  // Tamper the test to pass trivially, and commit it so a plain `checkout HEAD` wouldn't help.
  writeFileSync(testPath, "class Tampered:\n    def test(self):\n        assert True\n");
  git("commit", "-aqm", "agent tampers the test");

  // The restore half of the scoring command: pull the test file from the immutable root commit.
  const rootCommit = git("rev-list", "--max-parents=0", "HEAD");
  git("checkout", rootCommit, "--", bug.testFile);

  assert.equal(
    readFileSync(testPath, "utf8"),
    pristine,
    "the tampered test is reverted to pristine",
  );
  assert.equal(
    readFileSync(sourcePath, "utf8"),
    fixedSource,
    "the agent's source edit is untouched",
  );
});
