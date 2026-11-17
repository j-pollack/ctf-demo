import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { startTunnel } from "./tunnel";
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
  // Sprites reach the app only through a public origin. A SITE_URL set in the shell wins;
  // otherwise an ngrok tunnel provides one. Either way it overrides SITE_URL in .env.local,
  // and without a tunnel it is cleared so runs report the endpoint as unavailable.
  const tunnel = process.env.SITE_URL ? undefined : await startTunnel(info.port);
  if (tunnel && "error" in tunnel)
    console.warn(`No tunnel: ${tunnel.error} New runs cannot start until SITE_URL is set.`);
  const siteUrl = process.env.SITE_URL || (tunnel && "url" in tunnel ? tunnel.url : "");
  if (siteUrl) console.log(`Site URL: ${siteUrl}`);
  const env = {
    ...process.env,
    PORT: String(info.port),
    BETTER_AUTH_URL: info.origin,
    TRIPWIRE_COOKIE_PREFIX: info.cookiePrefix,
    SITE_URL: siteUrl,
  };
  const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");
  // The app, the monitor worker and the tunnel form one system: without the worker, async
  // reviews and pending submissions never progress, and without the tunnel no upload arrives.
  // If any of them stops, stop the rest.
  const children: ChildProcess[] = [
    ...(tunnel && "child" in tunnel ? [tunnel.child] : []),
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
