import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";

export type TestPostgres = { name: string; database: string; port: string; remove: () => void };

const docker = (...args: string[]) =>
  execFileSync("docker", args, { encoding: "utf8", timeout: 30_000 }).trim();

// A disposable Postgres bound to loopback only. The container removes itself when stopped and
// is also removed here if it never becomes ready, so a caller only removes what it got back.
export async function startPostgres(
  prefix: string,
  isStopped: () => boolean = () => false,
): Promise<TestPostgres> {
  const name = `${prefix}-${randomUUID()}`;
  const database = `${prefix.replaceAll("-", "_")}_${randomUUID().replaceAll("-", "")}`;
  const remove = () => {
    docker("rm", "--force", name);
  };
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
  try {
    let ready = false;
    for (let i = 0; i < 60 && !isStopped(); i++) {
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
    if (!ready || isStopped()) throw new Error("Test Postgres did not become ready.");
    const port = docker("port", name, "5432/tcp").match(/^127\.0\.0\.1:(\d+)$/)?.[1];
    if (!port) throw new Error("Test Postgres must bind only to loopback.");
    return { name, database, port, remove };
  } catch (error) {
    remove();
    throw error;
  }
}
