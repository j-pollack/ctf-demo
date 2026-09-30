import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerWorktree } from "../scripts/worktree";

test("worktrees reserve distinct ports, copy private credentials once, and prune deleted checkouts", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tripwire-worktrees-")));
  const main = join(root, "main");
  const second = join(root, "second");
  const third = join(root, "third");
  mkdirSync(main);
  // Exercise hook isolation even outside a hook; this Git directory must never be consulted.
  const gitEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.startsWith("GIT_")),
  );
  process.env.GIT_DIR = join(root, "hook.git");
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) {
      delete env[key];
      delete process.env[key]; // Direct registerWorktree calls also spawn Git.
    }
  }
  const git = (...args: string[]) => execFileSync("git", args, { cwd: main, stdio: "pipe", env });
  try {
    git("init");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "test",
    );
    git("worktree", "add", "-b", "second", second);
    git("worktree", "add", "-b", "third", third);
    writeFileSync(join(main, ".env.local"), "FAKE_KEY=test-only\n");
    const init = (cwd: string) =>
      promisify(execFile)(
        process.execPath,
        [
          "--import",
          createRequire(import.meta.url).resolve("tsx"),
          fileURLToPath(new URL("../scripts/worktree.ts", import.meta.url)),
          "init",
        ],
        { cwd, env: { ...env, PORT: "" } },
      );
    await Promise.all([init(second), init(third)]);
    const [a, b, c] = await Promise.all([
      registerWorktree(main),
      registerWorktree(second),
      registerWorktree(third),
    ]);
    assert.equal(new Set([a.port, b.port, c.port]).size, 3);
    assert.equal(new Set([a.manifest, b.manifest, c.manifest]).size, 1);
    assert.notEqual(a.cookiePrefix, b.cookiePrefix);
    assert.equal(readFileSync(join(second, ".env.local"), "utf8"), "FAKE_KEY=test-only\n");
    assert.equal(statSync(join(second, ".env.local")).mode & 0o777, 0o600);
    writeFileSync(join(second, ".env.local"), "FAKE_KEY=independent\n");
    assert.equal((await registerWorktree(second)).port, b.port);
    assert.equal(readFileSync(join(second, ".env.local"), "utf8"), "FAKE_KEY=independent\n");
    await assert.rejects(registerWorktree(second, a.port), /reserved/);
    await assert.rejects(registerWorktree(second, NaN), /PORT/);
    await assert.rejects(registerWorktree(second, 0), /PORT/);
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(b.port, resolve));
    try {
      await assert.rejects(registerWorktree(second, b.port), /occupied/);
      assert.notEqual((await registerWorktree(second)).port, b.port);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    git("worktree", "remove", "--force", third);
    await registerWorktree(main);
    const manifest = readFileSync(a.manifest, "utf8");
    assert.equal(JSON.parse(manifest).length, 2);
    assert.ok(!manifest.includes(third));
    assert.ok(!manifest.includes("FAKE_KEY"));
    assert.equal(readFileSync(join(main, ".env.local"), "utf8"), "FAKE_KEY=test-only\n");
  } finally {
    Object.assign(process.env, gitEnv);
    rmSync(root, { recursive: true, force: true });
  }
});
