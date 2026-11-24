import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { once } from "node:events";
import { setTimeout } from "node:timers/promises";

const name = `ctf-integration-${randomUUID()}`;
const database = `ctf_integration_${randomUUID().replaceAll("-", "")}`;
const integrationFiles = readdirSync("tests/integration")
  .filter((file) => file.endsWith(".test.ts"))
  .map((file) => `tests/integration/${file}`);
const args = process.argv.slice(2);
const realTiming = args[0] === "--real-timing";
if (realTiming && args.length !== 1)
  throw new Error("--real-timing runs only the production deadline contract.");
const requestedFiles = realTiming ? ["tests/integration/flag-read-production.test.ts"] : args;
if (requestedFiles.some((file) => !integrationFiles.includes(file)))
  throw new Error(
    `Integration test selection must use an existing tests/integration/*.test.ts path: ${requestedFiles.find((file) => !integrationFiles.includes(file))}`,
  );
if (new Set(requestedFiles).size !== requestedFiles.length)
  throw new Error("Integration test selection cannot contain duplicates.");
const selectedFiles = requestedFiles.length ? requestedFiles : integrationFiles;
const docker = (...args: string[]) =>
  execFileSync("docker", args, { encoding: "utf8", timeout: 30_000 }).trim();
let created = false;
let stopped = false;
let child: ReturnType<typeof spawn> | undefined;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    stopped = true;
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    child?.kill(signal);
  });
try {
  // Never pull during a test run: prepare the image explicitly once.
  docker(
    "run",
    "--detach",
    "--rm",
    "--pull=never",
    "--name",
    name,
    "--publish",
    "127.0.0.1::5432",
    "--env",
    "POSTGRES_HOST_AUTH_METHOD=trust",
    "--env",
    `POSTGRES_DB=${database}`,
    "postgres:18-alpine",
  );
  created = true;
  let ready = false;
  for (let i = 0; i < 60 && !stopped; i++) {
    try {
      docker(
        "exec",
        name,
        "pg_isready",
        "--host=127.0.0.1",
        "--username=postgres",
        `--dbname=${database}`,
      );
      ready = true;
      break;
    } catch {
      await setTimeout(250);
    }
  }
  if (!ready || stopped) throw new Error("Integration Postgres did not become ready.");
  const port = docker("port", name, "5432/tcp").match(/^127\.0\.0\.1:(\d+)$/)?.[1];
  if (!port) throw new Error("Integration Postgres must bind only to loopback.");
  // No .env files, production connection URLs, Node preload options or paid credentials.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SystemRoot", "NODE_V8_COVERAGE"].includes(key),
    ),
  );
  const reporter = "--test-reporter=./scripts/test-integration-reporter.ts";
  child = spawn(process.execPath, ["--import", "tsx", "--test", reporter, ...selectedFiles], {
    stdio: "inherit",
    env: {
      ...env,
      NODE_ENV: "test",
      ...(realTiming ? { CTF_REAL_MONITOR_TIMING: "1" } : {}),
      SPRITE_TOKEN: "integration-sprite-token",
      OPENROUTER_API_KEY: "integration-router-key",
      SITE_URL: "https://flags.integration.test",
      CTF_INTEGRATION_DATABASE_URL: `postgresql://postgres@127.0.0.1:${port}/${database}`,
    },
  });
  const [code] = await once(child, "exit");
  process.exitCode = stopped ? process.exitCode : (code ?? 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode ||= 1;
} finally {
  if (created) docker("rm", "--force", name);
}
