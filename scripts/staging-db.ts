import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";

// Reads staging's database for the staging workflow. The connection string comes from the
// environment only. Errors print a fixed message and the error's code, never its text, because a
// connection error can quote the string.
const POLL_MS = 5_000;
const UUID = /^[0-9a-f-]{36}$/;
const WAKE_KEY = "worker_wake";

// Its message is fixed text, so it is safe to print.
class Refused extends Error {}

// The staging member: the real stack signs in as Resend's test recipient (`newEmail` in
// tests/e2e/stack.ts). Staging is public, so only this member's runs are judged.
const MEMBER_EMAIL = "delivered@resend.dev";

// True when none of the member's runs would make lib/games.ts refuse a new run: one creating or
// finalizing under the legacy monitor, a live lease on an open run, or an active run whose flag
// receipt still waits for its command. With no such member there are no rows, so it passes.
const QUIET_SQL = `WITH g AS (
  SELECT g.* FROM ctf.games g WHERE g.owner_id=(SELECT id FROM ctf."user" WHERE email=$1)
)
SELECT NOT (
  EXISTS(SELECT 1 FROM g WHERE status='creating' OR (status='finalizing' AND monitor_mode='legacy'))
  OR EXISTS(SELECT 1 FROM g JOIN ctf.agent_sessions s ON s.game_id=g.id
    WHERE (g.status IN ('creating','active') OR (g.status='finalizing' AND g.monitor_mode='legacy'))
      AND s.lease_until>now())
  OR EXISTS(SELECT 1 FROM g WHERE g.status='active'
    AND EXISTS(SELECT 1 FROM ctf.flag_submissions r WHERE r.game_id=g.id)
    AND NOT EXISTS(SELECT 1 FROM ctf.sprite_operations o
      LEFT JOIN ctf.agent_sessions s ON s.game_id=o.game_id AND s.id=o.session_id
      WHERE o.game_id=g.id AND o.kind='command' AND o.status='running'
        AND (s.lease_until IS NULL OR s.lease_until<=now())))
) AS ok`;

// The registration row must have been written after `since`, the database's own clock.
const WAKE_SQL = `SELECT (updated_at > $2::timestamptz) AS ok FROM ctf.settings WHERE key=$1`;

async function poll(client: pg.Client, seconds: number, ready: () => Promise<boolean>) {
  const deadline = Date.now() + seconds * 1_000;
  for (;;) {
    if (await ready()) return;
    if (Date.now() >= deadline) throw new Refused("Timed out.");
    await sleep(POLL_MS);
  }
}

async function run(client: pg.Client, command: string, args: string[]) {
  if (command === "clock") {
    const { rows } = await client.query(
      "SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS now",
    );
    console.log(rows[0].now);
  } else if (command === "wait-worker") {
    // `since` is "none" when the branch did not move and an existing row is enough.
    const [since, seconds] = args;
    await poll(client, Number(seconds), async () => {
      const { rows } = await client.query(
        since === "none" ? `SELECT true AS ok FROM ctf.settings WHERE key=$1` : WAKE_SQL,
        since === "none" ? [WAKE_KEY] : [WAKE_KEY, since],
      );
      return rows[0]?.ok === true;
    });
  } else if (command === "wait-quiet") {
    await poll(
      client,
      Number(args[0]),
      async () => (await client.query(QUIET_SQL, [MEMBER_EMAIL])).rows[0].ok,
    );
  } else if (command === "cost") {
    if (!UUID.test(args[0] ?? "")) throw new Refused("Malformed run id.");
    const { rows } = await client.query(
      `SELECT coalesce(sum(cost),0)::bigint AS micro FROM ctf.inference WHERE game_id=$1`,
      [args[0]],
    );
    console.log((Number(rows[0].micro) / 1_000_000).toFixed(4));
  } else
    throw new Refused(
      "Usage: staging-db.ts <clock|wait-worker <since|none> <s>|wait-quiet <s>|cost <run id>>",
    );
}

const url = process.env.STAGING_DATABASE_URL;
if (!url) {
  console.error("STAGING_DATABASE_URL is not set.");
  process.exit(1);
}
let client: pg.Client | undefined;
try {
  client = new pg.Client({ connectionString: url });
  await client.connect();
  await run(client, process.argv[2] ?? "", process.argv.slice(3));
} catch (error) {
  const code = (error as { code?: string }).code;
  console.error(
    error instanceof Refused ? error.message : `Database error${code ? ` (code ${code})` : ""}`,
  );
  process.exitCode = 1;
} finally {
  await client?.end().catch(() => undefined);
}
