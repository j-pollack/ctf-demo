import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BOTTLE_COMMIT, BOTTLE_REPO, SEED_BUGS, SUITE_COMMAND, tasksMarkdown } from "../lib/seed";

// Builds seed/workspace.tar.gz: Bottle at BOTTLE_COMMIT with seed/bugs/*.patch applied, as a
// fresh one-commit repo. Upstream history is left out because it contains every fix.
const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "ctf-seed-"));
const upstream = join(temp, "upstream");
const workspace = join(temp, "workspace");
const run = (cwd: string, file: string, ...args: string[]) =>
  execFileSync(file, args, { cwd, stdio: ["ignore", "pipe", "inherit"] });
const passes = (command: string) =>
  spawnSync("bash", ["-c", command], {
    cwd: workspace,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    stdio: "ignore",
    timeout: 15_000,
  }).status === 0;
try {
  run(temp, "git", "clone", "--quiet", "--no-checkout", BOTTLE_REPO, upstream);
  run(temp, "mkdir", workspace);
  // Translations are 2.5 MB of the docs and irrelevant to the bugs; leave them out.
  execFileSync("bash", [
    "-c",
    `git -C ${upstream} archive ${BOTTLE_COMMIT} | tar -x -C ${workspace} --exclude docs/_locale`,
  ]);
  if (!passes(SUITE_COMMAND)) throw new Error("The clean upstream suite fails.");
  const patches = readdirSync(join(root, "seed/bugs"))
    .filter((name) => name.endsWith(".patch"))
    .sort();
  if (patches.length !== SEED_BUGS.length) throw new Error("Patches and SEED_BUGS disagree.");
  for (const patch of patches) run(workspace, "git", "apply", join(root, "seed/bugs", patch));
  // Each bug must be live in the seed; build-time Python is assumed close to the sprite's.
  for (const bug of SEED_BUGS)
    if (passes(bug.test)) throw new Error(`${bug.id} passes; its bug is not seeded.`);
  writeFileSync(join(workspace, "TASKS.md"), tasksMarkdown());
  run(workspace, "git", "init", "--quiet", "--initial-branch=main");
  run(workspace, "git", "add", "-A");
  run(
    workspace,
    "git",
    "-c",
    "user.name=Bottle",
    "-c",
    "user.email=bottle@example.com",
    "commit",
    "--quiet",
    "-m",
    "Import Bottle",
  );
  // Pack the objects, drop temporary files, and undo the macOS defaults `git init` wrote.
  run(workspace, "git", "gc", "--quiet", "--prune=now");
  run(workspace, "git", "config", "core.ignorecase", "false");
  run(workspace, "git", "config", "--unset", "core.precomposeunicode");
  // Keep macOS metadata out of a Linux tarball.
  execFileSync("tar", ["--no-xattrs", "-czf", join(root, "seed/workspace.tar.gz"), "."], {
    cwd: workspace,
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  console.log("Wrote seed/workspace.tar.gz");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
