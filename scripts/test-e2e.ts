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
import { Client } from "pg";
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
// Names that are empty in a child unless its stage sets one, whether or not an env file defines them.
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
// The address contact mail goes to. A fixed value, so the tests can name it.
const CONTACT_EMAIL = "contact@ctf.example.test";
// The host a run's submission URL names. Its Sprite never reaches the network: the preload fakes it.
const SUBMISSION_HOST = "ctf.e2e.test";
const ARTIFACTS = resolve(".artifacts/e2e");
export const VIOLATIONS_FILE = resolve(ARTIFACTS, "violations.jsonl");
export const MAIL_FILE = resolve(ARTIFACTS, "mail.jsonl");
export const VISITOR_FILE = resolve(ARTIFACTS, "visitors.txt");
export const SPRITE_DIR = resolve(ARTIFACTS, "sprites");
export const SERVER_LOG = resolve(ARTIFACTS, "server.log");
export const LOG_CURSOR_FILE = resolve(ARTIFACTS, "server-log.cursor");
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
  const files = {
    E2E_VIOLATIONS_FILE: VIOLATIONS_FILE,
    E2E_MAIL_FILE: MAIL_FILE,
    E2E_SPRITE_DIR: SPRITE_DIR,
  };
  if (stage === "build") return { ...app, DATABASE_URL_UNPOOLED: UNREACHABLE_DATABASE };
  if (stage === "migrate") return { ...database, ...app };
  if (stage === "test")
    return {
      ...database,
      ...files,
      CRON_SECRET: app.CRON_SECRET,
      CONTACT_EMAIL,
      E2E_VISITOR_FILE: VISITOR_FILE,
      E2E_SERVER_LOG: SERVER_LOG,
      E2E_LOG_CURSOR: LOG_CURSOR_FILE,
      E2E_BASE_URL: origin(stack.port),
    };
  // Mail is configured for the server alone: the build and the migration send none.
  const mail = { FASTMAIL_API_TOKEN: "e2e-fastmail-token", CONTACT_EMAIL };
  return {
    ...database,
    ...app,
    ...files,
    ...mail,
    VERCEL_URL: SUBMISSION_HOST,
    NODE_OPTIONS: `--import tsx --import ${PRELOAD}`,
  };
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

// A route that throws, a settings read that falls back and a task that fails are logged and
// answered gracefully, so only the log shows them. The unawaited-task event is logged when
// scheduling a task with `after()` throws outside a request scope, and the task then runs with
// nothing awaiting it.
// A screen that times out lets an instruction through unscreened, so it fails a story too.
const FAILURE_EVENTS = new Set(["auth.background_task_unawaited", "text_screen.request_timed_out"]);
export function failureEvents(lines: string[]): Record<string, unknown>[] {
  return lines.flatMap((line) => {
    try {
      const entry = JSON.parse(line) as Record<string, unknown> | null;
      const event = entry?.event;
      const failed =
        typeof event === "string" && (event.endsWith("failed") || FAILURE_EVENTS.has(event));
      return failed ? [entry!] : [];
    } catch {
      return [];
    }
  });
}

// The whole lines in the log after a byte offset, and the offset after the last of them. A line the
// server is still writing has no newline yet, so it is left for the next read.
export function newLines(log: Buffer, offset: number): { lines: string[]; offset: number } {
  const end = log.lastIndexOf("\n") + 1;
  if (end <= offset) return { lines: [], offset };
  return { lines: log.subarray(offset, end).toString().split("\n").filter(Boolean), offset: end };
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
  let testCode: number | undefined;
  let stack: Stack | undefined;
  try {
    rmSync(ARTIFACTS, { recursive: true, force: true });
    mkdirSync(SPRITE_DIR, { recursive: true });
    writeFileSync(VIOLATIONS_FILE, "");
    writeFileSync(MAIL_FILE, "");
    writeFileSync(VISITOR_FILE, "");
    writeFileSync(LOG_CURSOR_FILE, "0");
    const port = Number(process.env.PORT) || (await freePort());
    const noDatabase = { port, dbPort: "", database: "" };
    if (await run("build", noDatabase, next("build"))) throw new Error("The build failed.");
    postgres = await startPostgres("ctf-e2e", () => stopped);
    stack = { port, dbPort: postgres.port, database: postgres.database };
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
    testCode = files.length
      ? await run("test", stack, ["--import", "tsx", "--test", "--test-concurrency=1", ...files])
      : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode ||= 1;
  } finally {
    try {
      if (server) await stopServer(server);
      // Read only once the server has stopped, so the log is complete. A run stopped by a signal
      // skips it. These lines explain a failed run as often as a passing one, so they are always shown.
      if (testCode !== undefined && !stopped) {
        const problems = [
          ...endOfRunProblems(),
          ...runProblems(await readRuns(stack!), readdirSync(SPRITE_DIR), !process.argv[2]),
        ];
        for (const problem of problems) console.error(problem);
        process.exitCode = testCode || (problems.length ? 1 : 0);
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode ||= 1;
    } finally {
      if (serverLog !== undefined) closeSync(serverLog);
      postgres?.remove();
    }
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

type RunRow = { id: string; sprite_name: string; status: string; sprite_deleted_at: Date | null };

// The runs the stories left, read from the disposable database once the server has stopped.
async function readRuns(stack: Stack): Promise<RunRow[]> {
  const client = new Client({
    host: "127.0.0.1",
    port: Number(stack.dbPort),
    user: "postgres",
    database: stack.database,
  });
  await client.connect();
  try {
    return (
      await client.query<RunRow>("SELECT id,sprite_name,status,sprite_deleted_at FROM ctf.games")
    ).rows;
  } finally {
    await client.end();
  }
}

// After the stories no run is open, and the Sprite directories are the Sprites of the runs whose
// Sprite is not marked deleted. A full run must also have started a run, or the check proves nothing.
export function runProblems(runs: RunRow[], directories: string[], requireRuns: boolean) {
  const problems = runs
    .filter((run) => run.status === "active" || run.status === "creating")
    .map((run) => `Run ${run.id} is still ${run.status} after the tests.`);
  const kept = [
    ...new Set(runs.filter((run) => !run.sprite_deleted_at).map((run) => run.sprite_name)),
  ];
  const expected = kept.sort().join(",");
  const actual = [...directories].sort().join(",");
  if (expected !== actual)
    problems.push(`Sprite directories [${actual}] differ from the undeleted runs' [${expected}].`);
  if (requireRuns && !runs.length) problems.push("No story started a run.");
  return problems;
}

function endOfRunProblems() {
  // The preload recreates the violations file on its next append, so a missing file is empty.
  const violations = existsSync(VIOLATIONS_FILE)
    ? readFileSync(VIOLATIONS_FILE, "utf8").split("\n").filter(Boolean)
    : [];
  // The journeys have taken the log up to the cursor; what is left came after the last of them.
  const { lines } = newLines(
    readFileSync(SERVER_LOG),
    Number(readFileSync(LOG_CURSOR_FILE, "utf8")),
  );
  return [
    ...violations.map((line) => `Unexpected violation left after the tests: ${line}`),
    ...failureEvents(lines).map((entry) => `Server log: ${JSON.stringify(entry)}`),
  ];
}

if (import.meta.main) await main();
