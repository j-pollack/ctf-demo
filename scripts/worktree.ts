import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";

type Entry = { path: string; port: number };
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
export const cookiePrefix = (path: string) =>
  `tripwire-${createHash("sha256").update(path).digest("hex").slice(0, 12)}`;

export async function portAvailable(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES") resolve(false);
      else reject(error);
    });
    server.listen(port, () => server.close(() => resolve(true)));
  });
}

export async function registerWorktree(cwd: string, requested?: number) {
  const path = realpathSync(cwd);
  const common = git(path, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const manifest = join(common, "tripwire-worktrees.json");
  const lock = `${manifest}.lock`;
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const pid = Number(readFileSync(lock, "utf8"));
        if (pid > 0) {
          try {
            process.kill(pid, 0);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ESRCH") unlinkSync(lock);
          }
        } else if (Date.now() - statSync(lock).mtimeMs > 30000) unlinkSync(lock);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (Date.now() > deadline) throw new Error(`Worktree registry is locked: ${lock}`);
      await setTimeout(50);
    }
  }
  try {
    const paths = git(path, "worktree", "list", "--porcelain", "-z")
      .split("\0")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice(9))
      .filter(existsSync)
      .map((path) => realpathSync(path));
    const entries: Entry[] = existsSync(manifest) ? JSON.parse(readFileSync(manifest, "utf8")) : [];
    const live = entries.filter((entry) => paths.includes(entry.path));
    if (
      requested !== undefined &&
      (!Number.isInteger(requested) || requested < 1024 || requested > 65535)
    )
      throw new Error("PORT must be an integer between 1024 and 65535.");
    const used = new Set(live.filter((entry) => entry.path !== path).map((entry) => entry.port));
    let port = requested ?? live.find((entry) => entry.path === path)?.port ?? 3001;
    if (requested !== undefined && (used.has(port) || !(await portAvailable(port))))
      throw new Error(`Port ${port} is occupied or reserved by another worktree.`);
    while (used.has(port) || !(await portAvailable(port))) {
      if (++port > 65535) throw new Error("No free development port.");
    }
    const source = paths.find(
      (candidate) => candidate !== path && existsSync(join(candidate, ".env.local")),
    );
    if (!existsSync(join(path, ".env.local")) && source) {
      writeFileSync(join(path, ".env.local"), readFileSync(join(source, ".env.local")), {
        flag: "wx",
        mode: 0o600,
      });
      // Copy contents, not shared symlinks; credentials remain private and independently editable.
    }
    const updated = [...live.filter((entry) => entry.path !== path), { path, port }];
    writeFileSync(`${manifest}.tmp`, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });
    renameSync(`${manifest}.tmp`, manifest);
    return {
      path,
      port,
      manifest,
      origin: `http://localhost:${port}`,
      cookiePrefix: cookiePrefix(path),
    };
  } finally {
    unlinkSync(lock);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command = "init", destination, branch] = process.argv.slice(2);
    let cwd = process.cwd();
    if (command === "add") {
      if (!destination || !branch)
        throw new Error("Usage: npm run worktree -- add <path> <new-branch>");
      execFileSync("git", ["worktree", "add", "-b", branch, resolve(destination)], {
        stdio: "inherit",
      });
      cwd = resolve(destination);
    } else if (command !== "init")
      throw new Error("Use worktree add <path> <new-branch> or worktree init.");
    const info = await registerWorktree(
      cwd,
      process.env.PORT ? Number(process.env.PORT) : undefined,
    );
    console.log(
      `${info.origin}\nManifest: ${info.manifest}\ncd ${JSON.stringify(info.path)} && npm install && npm run dev`,
    );
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
