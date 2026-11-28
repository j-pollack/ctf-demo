import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { once } from "node:events";
import { startPostgres, type TestPostgres } from "./test-postgres";

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
let postgres: TestPostgres | undefined;
let stopped = false;
let child: ReturnType<typeof spawn> | undefined;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    stopped = true;
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    child?.kill(signal);
  });
try {
  postgres = await startPostgres("ctf-integration", () => stopped);
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
      CTF_INTEGRATION_DATABASE_URL: `postgresql://postgres@127.0.0.1:${postgres.port}/${postgres.database}`,
    },
  });
  const [code] = await once(child, "exit");
  process.exitCode = stopped ? process.exitCode : (code ?? 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode ||= 1;
} finally {
  postgres?.remove();
}
