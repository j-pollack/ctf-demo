import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

// Git hooks export GIT_DIR and GIT_INDEX_FILE. Left in place, every git command below would act
// on this repository instead of the temporary ones it names.
for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) delete process.env[key];

// The staging workflow checks out one commit and pushes it to `staging` without force. The client
// proves the fast-forward itself, so the checkout needs the history down to staging's tip.
const IDENTITY = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid"];
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", [...IDENTITY, "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const push = (cwd: string, sha: string) => {
  try {
    git(cwd, "push", "origin", `${sha}:refs/heads/staging`);
    return true;
  } catch {
    return false;
  }
};

let root = "";
let remote = "";
let mainTip = "";
let sideTip = "";
const url = () => `file://${remote}`;

before(() => {
  root = mkdtempSync(join(tmpdir(), "staging-push-"));
  remote = join(root, "remote.git");
  const seed = join(root, "seed");
  git(root, "init", "--bare", "--initial-branch=main", remote);
  git(root, "init", "--initial-branch=main", seed);
  git(seed, "remote", "add", "origin", url());
  git(seed, "commit", "--allow-empty", "-m", "one");
  git(seed, "push", "origin", "HEAD:refs/heads/staging");
  git(seed, "commit", "--allow-empty", "-m", "two");
  git(seed, "commit", "--allow-empty", "-m", "three");
  mainTip = git(seed, "rev-parse", "HEAD");
  git(seed, "push", "origin", "main");
  // A commit that does not descend from staging's tip.
  git(seed, "checkout", "--orphan", "side");
  git(seed, "commit", "--allow-empty", "-m", "unrelated");
  sideTip = git(seed, "rev-parse", "HEAD");
  git(seed, "push", "origin", "side");
});

after(() => rmSync(root, { recursive: true, force: true }));

function clone(name: string, depth?: number) {
  const dir = join(root, name);
  const args = depth ? ["--depth", String(depth)] : [];
  git(root, "clone", ...args, "--no-single-branch", url(), dir);
  return dir;
}

test("a shallow checkout cannot fast-forward staging", () => {
  const dir = clone("shallow", 1);
  assert.equal(push(dir, mainTip), false);
});

test("a full checkout fast-forwards staging", () => {
  const dir = clone("full");
  assert.equal(push(dir, mainTip), true);
  assert.equal(git(remote, "rev-parse", "refs/heads/staging"), mainTip);
});

test("a commit that does not descend from staging is refused in both checkouts", () => {
  for (const dir of [clone("shallow-side", 1), clone("full-side")]) {
    assert.equal(push(dir, sideTip), false, dir);
  }
  assert.notEqual(git(remote, "rev-parse", "refs/heads/staging"), sideTip);
});

test("the workflow's checkout fetches the whole history", () => {
  const workflow = readFileSync(
    fileURLToPath(new URL("../.github/workflows/staging.yml", import.meta.url)),
    "utf8",
  );
  const step = workflow.split("uses: actions/checkout@")[1]?.split("- name:")[0] ?? "";
  assert.match(step, /fetch-depth: 0/);
});
