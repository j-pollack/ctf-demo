import { db } from "./db";

export const WAKE_KEY = "worker_wake";
const WAKE_TIMEOUT_MS = 2_000;
const UNDEFINED_TABLE = "42P01";

// Its message is safe to log: it never carries the registration.
class WakeFailure extends Error {}

export type WakeRegistration = { url: string; instance: string | null; token: string };

export function parseRegistration(value: string): WakeRegistration | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { url, instance, token } = parsed as Record<string, unknown>;
  if (typeof url !== "string" || typeof token !== "string" || !token) return null;
  if (instance !== null && typeof instance !== "string") return null;
  try {
    const target = new URL(url);
    const local = target.protocol === "http:" && target.hostname === "127.0.0.1";
    if (target.protocol !== "https:" && !local) return null;
  } catch {
    return null;
  }
  return { url, instance, token };
}

async function sendWake() {
  let value: string | undefined;
  try {
    ({
      rows: [{ value } = { value: undefined }],
    } = await db.query<{ value: string }>("SELECT value FROM ctf.settings WHERE key=$1", [
      WAKE_KEY,
    ]));
  } catch (error) {
    if ((error as { code?: string }).code === UNDEFINED_TABLE) return;
    throw error;
  }
  if (value === undefined) return;
  const registration = parseRegistration(value);
  if (!registration) throw new WakeFailure("malformed");
  const headers: Record<string, string> = { authorization: `Bearer ${registration.token}` };
  if (registration.instance) headers["fly-force-instance-id"] = registration.instance;
  const response = await fetch(registration.url, {
    method: "POST",
    headers,
    // A redirect could point the request at a host the URL check never saw.
    redirect: "manual",
    signal: AbortSignal.timeout(WAKE_TIMEOUT_MS),
  });
  await response.body?.cancel();
  if (response.status !== 204) throw new WakeFailure(`status ${response.status}`);
}

// Tells the monitor worker that work was queued. It never rejects and never touches the caller's
// transaction: a worker that is already polling needs no wake, and one that misses it still runs
// its safety pass. Callers inside a transaction or a long response do not await it.
export function wakeWorker(): Promise<void> {
  return sendWake().catch((error: unknown) => {
    const cause = (error as { cause?: { code?: string } }).cause?.code;
    const reason = error instanceof WakeFailure ? error.message : (cause ?? (error as Error).name);
    console.error(JSON.stringify({ event: "worker.wake.failed", reason }));
  });
}
