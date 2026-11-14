import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { registerWorktree } from "./worktree";

const args = process.argv.slice(2);
let requested = process.env.PORT;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port" || args[i] === "-p") requested = args.splice(i--, 2)[1] ?? "";
  else if (args[i].startsWith("--port=")) requested = args.splice(i--, 1)[0].slice(7);
}
try {
  const info = await registerWorktree(
    process.cwd(),
    requested === undefined ? undefined : Number(requested),
  );
  console.log(`Worktree: ${info.path}\nDev URL: ${info.origin}\nManifest: ${info.manifest}`);
  const env = {
    ...process.env,
    PORT: String(info.port),
    BETTER_AUTH_URL: info.origin,
    TRIPWIRE_COOKIE_PREFIX: info.cookiePrefix,
  };
  const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");
  // The app and the monitor worker form one system: without the worker, async reviews and
  // pending submissions never progress. If either process stops, stop the other.
  const children: ChildProcess[] = [
    spawn(process.execPath, [nextBin, "dev", "--port", String(info.port), ...args], {
      stdio: "inherit",
      env,
    }),
    spawn(
      process.execPath,
      ["--env-file=.env.local", "--import", "tsx", "scripts/monitor-worker.ts"],
      { stdio: "inherit", env },
    ),
  ];
  const stopAll = (signal: NodeJS.Signals) => children.forEach((child) => child.kill(signal));
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => stopAll(signal));
  for (const child of children) {
    child.on("error", (error) => {
      console.error(error.message);
      process.exitCode = 1;
      stopAll("SIGTERM");
    });
    child.on("exit", (code) => {
      process.exitCode ||= code ?? 0;
      stopAll("SIGTERM");
    });
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
