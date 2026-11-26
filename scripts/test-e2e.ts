import { spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { once } from "node:events";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { startPostgres, type TestPostgres } from "./test-postgres";

export type Stage = "build" | "migrate" | "server" | "test";
export type Stack = { port: number; dbPort: string; database: string };

const INHERITED = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SystemRoot",
  "NODE_V8_COVERAGE",
  "PLAYWRIGHT_BROWSERS_PATH",
];
// Names that stay empty in every child, whether or not an env file defines them.
const ALWAYS_EMPTY = [
  "DATABASE_URL",
  "DATABASE_URL_UNPOOLED",
  "SITE_URL",
  "TRIPWIRE_COOKIE_PREFIX",
  "FASTMAIL_API_TOKEN",
  "CONTACT_EMAIL",
  "ADMIN_EMAILS",
];
// The build reads the database module but never connects, as in the ci workflow.
const UNREACHABLE_DATABASE = "postgresql://unavailable:unavailable@127.0.0.1:1/ctf";
const ARTIFACTS = resolve(".artifacts/e2e");
export const VIOLATIONS_FILE = resolve(ARTIFACTS, "violations.jsonl");
export const MAIL_FILE = resolve(ARTIFACTS, "mail.jsonl");
export const VISITOR_FILE = resolve(ARTIFACTS, "visitors.txt");
const SERVER_LOG = resolve(ARTIFACTS, "server.log");
const PRELOAD = resolve("tests/e2e/preload.ts");

// Each file is read whole and only the names are kept. The pattern is the key and separator part
// of the dotenv bundled in @next/env, so a name Next would load is a name that gets blanked.
const ENV_NAME = /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=|:\s)/gm;
export function envFileNames(files: Record<string, string>): string[] {
  const names = Object.entries(files)
    .filter(([file]) => file.startsWith(".env"))
    .flatMap(([, text]) => [...text.replaceAll("\r\n", "\n").matchAll(ENV_NAME)].map((m) => m[1]));
  return [...new Set(names)].sort();
}

const origin = (port: number) => `http://127.0.0.1:${port}`;

function synthetic(stage: Stage, stack: Stack): Record<string, string> {
  const database = {
    DATABASE_URL: "",
    DATABASE_URL_UNPOOLED: "",
    PGHOST: "127.0.0.1",
    PGPORT: stack.dbPort,
    PGUSER: "postgres",
    PGDATABASE: stack.database,
  };
  const app = {
    BETTER_AUTH_SECRET: "e2e-auth-secret-not-for-real-use-000000000000",
    BETTER_AUTH_URL: origin(stack.port),
    CRON_SECRET: "e2e-cron-secret-not-for-real-use-000000000000",
    OPENROUTER_API_KEY: "e2e-router-key",
    SPRITE_TOKEN: "e2e-sprite-token",
    RESEND_API_KEY: "e2e-resend-key",
    RESEND_FROM: "e2e@example.invalid",
  };
  const files = { E2E_VIOLATIONS_FILE: VIOLATIONS_FILE, E2E_MAIL_FILE: MAIL_FILE };
  if (stage === "build") return { ...app, DATABASE_URL_UNPOOLED: UNREACHABLE_DATABASE };
  if (stage === "migrate") return { ...database, ...app };
  if (stage === "test")
    return {
      ...database,
      ...files,
      E2E_VISITOR_FILE: VISITOR_FILE,
      E2E_BASE_URL: origin(stack.port),
    };
  return { ...database, ...app, ...files, NODE_OPTIONS: `--import tsx --import ${PRELOAD}` };
}

// A child's whole environment: an allow-list of this process's variables, every name an env file
// defines set empty, then the synthetic values.
export function e2eEnv(
  stage: Stage,
  options: { inherited: Record<string, string | undefined>; fileNames: string[]; stack: Stack },
): NodeJS.ProcessEnv {
  const kept = INHERITED.flatMap((name) => {
    const value = options.inherited[name];
    return value === undefined ? [] : [[name, value]];
  });
  const blank = [...options.fileNames, ...ALWAYS_EMPTY].map((name) => [name, ""]);
  return {
    ...Object.fromEntries(kept),
    ...Object.fromEntries(blank),
    NEXT_TELEMETRY_DISABLED: "1",
    ...synthetic(stage, options.stack),
  };
}

export function assertSafeEnv(stage: Stage, env: NodeJS.ProcessEnv) {
  const expected = stage === "build" ? UNREACHABLE_DATABASE : "";
  if (env.DATABASE_URL !== "" || env.DATABASE_URL_UNPOOLED !== expected)
    throw new Error(`Refusing to start ${stage}: its database URLs are not the safe ones.`);
  if (stage !== "build" && env.PGHOST !== "127.0.0.1")
    throw new Error(`Refusing to start ${stage}: its database host is not loopback.`);
}

// The names the server must see empty: the preload reports any that carries a value.
export function emptyNames(env: NodeJS.ProcessEnv, fileNames: string[]): string[] {
  return [...new Set([...fileNames, ...ALWAYS_EMPTY])].filter((name) => env[name] === "");
}

// A failed route or settings read is logged and answered gracefully, so only the log shows it.
export function serverLogProblems(lines: string[]): string[] {
  return lines.filter((line) => {
    try {
      const event = (JSON.parse(line) as { event?: unknown }).event;
      return (
        typeof event === "string" && (event === "route.failed" || event.endsWith("_read_failed"))
      );
    } catch {
      return false;
    }
  });
}

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  server.close();
  if (!address || typeof address === "string") throw new Error("No free port.");
  return address.port;
}

function selectedFiles(args: string[]) {
  const all = readdirSync("tests/e2e")
    .filter((file) => file.endsWith(".test.ts"))
    .map((file) => `tests/e2e/${file}`);
  const unknown = args.find((file) => !all.includes(file));
  if (unknown)
    throw new Error(`E2E test selection must be an existing tests/e2e/*.test.ts path: ${unknown}`);
  if (new Set(args).size !== args.length)
    throw new Error("E2E test selection cannot contain duplicates.");
  return args.length ? args : all;
}

function readFileNames() {
  const files = Object.fromEntries(
    readdirSync(".")
      .filter((file) => file.startsWith(".env"))
      .map((file) => [file, readFileSync(file, "utf8")]),
  );
  return envFileNames(files);
}

async function main() {
  const files = selectedFiles(process.argv.slice(2));
  const fileNames = readFileNames();
  const inherited = process.env;
  let stopped = false;
  let current: ChildProcess | undefined;
  let postgres: TestPostgres | undefined;
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      stopped = true;
      process.exitCode = signal === "SIGINT" ? 130 : 143;
      current?.kill(signal);
    });
  const run = async (stage: Stage, stack: Stack, args: string[]) => {
    if (stopped) return 1;
    const env = e2eEnv(stage, { inherited, fileNames, stack });
    assertSafeEnv(stage, env);
    current = spawn(process.execPath, args, { stdio: "inherit", env });
    const [code] = await once(current, "exit");
    return (code as number | null) ?? 1;
  };
  const next = (...args: string[]) => ["node_modules/next/dist/bin/next", ...args];
  let server: ChildProcess | undefined;
  let serverLog: number | undefined;
  try {
    rmSync(ARTIFACTS, { recursive: true, force: true });
    mkdirSync(ARTIFACTS, { recursive: true });
    writeFileSync(VIOLATIONS_FILE, "");
    writeFileSync(MAIL_FILE, "");
    writeFileSync(VISITOR_FILE, "");
    const port = Number(process.env.PORT) || (await freePort());
    const noDatabase = { port, dbPort: "", database: "" };
    if (await run("build", noDatabase, next("build"))) throw new Error("The build failed.");
    postgres = await startPostgres("ctf-e2e", () => stopped);
    const stack = { port, dbPort: postgres.port, database: postgres.database };
    if (await run("migrate", stack, ["--import", "tsx", "scripts/setup.ts"]))
      throw new Error("The migration failed.");
    if (stopped) return;
    const serverEnv = e2eEnv("server", { inherited, fileNames, stack });
    assertSafeEnv("server", serverEnv);
    serverEnv.E2E_EMPTY_NAMES = emptyNames(serverEnv, fileNames).join(",");
    // One descriptor for both streams keeps lines whole, and the file exists before the server runs.
    serverLog = openSync(SERVER_LOG, "w");
    server = spawn(
      process.execPath,
      next("start", "--hostname", "127.0.0.1", "--port", String(port)),
      { stdio: ["ignore", serverLog, serverLog], env: serverEnv },
    );
    current = server;
    await waitForServer(server, port);
    // `node --test` with no files would discover tests anywhere, so an empty selection stops here.
    const code = files.length
      ? await run("test", stack, ["--import", "tsx", "--test", "--test-concurrency=1", ...files])
      : 0;
    if (stopped) return;
    // These lines explain a failed run as often as a passing one, so they are always shown.
    const problems = endOfRunProblems();
    for (const problem of problems) console.error(problem);
    process.exitCode = code || (problems.length ? 1 : 0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode ||= 1;
  } finally {
    if (server) await stopServer(server);
    if (serverLog !== undefined) closeSync(serverLog);
    postgres?.remove();
  }
}

const alive = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;
const STOP_GRACE_MS = 10_000;

async function stopServer(server: ChildProcess) {
  if (!alive(server)) return;
  const exited = once(server, "exit");
  server.kill("SIGTERM");
  const giveUp = new AbortController();
  const timeout = setTimeout(STOP_GRACE_MS, "timeout", { signal: giveUp.signal }).catch(
    () => "exited",
  );
  const outcome = await Promise.race([exited.then(() => "exited"), timeout]);
  giveUp.abort();
  if (outcome === "timeout") {
    server.kill("SIGKILL");
    await exited;
  }
}

async function waitForServer(server: ChildProcess, port: number) {
  for (let i = 0; i < 120; i++) {
    if (!alive(server)) break;
    try {
      if ((await fetch(origin(port))).ok) return;
    } catch {
      // Not listening yet.
    }
    await setTimeout(500);
  }
  throw new Error(
    `The server did not become ready. Its output:\n${readFileSync(SERVER_LOG, "utf8")}`,
  );
}

function endOfRunProblems() {
  // The preload recreates the violations file on its next append, so a missing file is empty.
  const text = (file: string) =>
    existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
  return [
    ...text(VIOLATIONS_FILE).map((line) => `Unexpected violation left after the tests: ${line}`),
    ...serverLogProblems(text(SERVER_LOG)).map((line) => `Server log: ${line}`),
  ];
}

if (import.meta.main) await main();
