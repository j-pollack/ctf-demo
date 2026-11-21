import { setTimeout as sleepFor } from "node:timers/promises";
import { db } from "../lib/db";
import { WAKE_KEY, parseRegistration } from "../lib/worker-wake";

// Run by the deploy jobs before they replace the worker: tells it to drain and waits until its
// registration row is gone. Usage: drain-worker.ts <expected origin> [wait seconds]
// It never prints the token or the database URL: only reason codes.
const POLL_MS = 2_000;
const SEND_TIMEOUT_MS = 10_000;
const DEFAULT_WAIT_SECONDS = 12 * 60;

const say = (event: string, reason?: string) =>
  console.log(JSON.stringify({ event: `worker.drain.${event}`, reason }));

async function readRow() {
  const { rows } = await db.query<{ value: string }>(
    "SELECT value FROM ctf.settings WHERE key=$1",
    [WAKE_KEY],
  );
  return rows[0]?.value;
}

async function drain(origin: string, waitSeconds: number) {
  const value = await readRow();
  if (value === undefined) return say("nothing");
  const registration = parseRegistration(value);
  if (!registration) return say("skipped", "malformed");
  const target = new URL(registration.url);
  // A preview's database can still hold production's row.
  if (target.origin !== new URL(origin).origin) return say("skipped", "origin");
  const headers: Record<string, string> = { authorization: `Bearer ${registration.token}` };
  if (registration.instance) headers["fly-force-instance-id"] = registration.instance;
  let status: number;
  try {
    const response = await fetch(new URL("/drain", target), {
      method: "POST",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    await response.body?.cancel();
    status = response.status;
  } catch (error) {
    return say(
      "failed",
      (error as { cause?: { code?: string } }).cause?.code ?? (error as Error).name,
    );
  }
  if (status !== 204) return say("failed", `status ${status}`);
  say("sent");
  const deadline = Date.now() + waitSeconds * 1_000;
  while (Date.now() < deadline) {
    await sleepFor(POLL_MS);
    // A query error is retried until the limit.
    if ((await readRow().catch(() => value)) !== value) return say("drained");
  }
  say("timeout");
}

try {
  const [origin, wait] = process.argv.slice(2);
  const waitSeconds = wait === undefined ? DEFAULT_WAIT_SECONDS : Number(wait);
  // Checked before the database is read.
  if (!URL.canParse(origin ?? "") || !(Number.isFinite(waitSeconds) && waitSeconds > 0)) {
    console.error(JSON.stringify({ event: "worker.drain.usage" }));
    process.exitCode = 1;
  } else await drain(origin, waitSeconds);
} catch (error) {
  // The name only: a database error's detail can quote the row, which holds the token.
  console.error(
    JSON.stringify({ event: "worker.drain.error", error: (error as Error).name ?? "Error" }),
  );
  process.exitCode = 1;
} finally {
  await db.end();
}
