import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Pool } from "pg";

const base = new URL(process.env.CTF_INTEGRATION_DATABASE_URL ?? "http://missing");
assert.equal(process.env.NODE_ENV, "test", "Use npm run test:integration");
assert.equal(base.hostname, "127.0.0.1");
assert.match(base.pathname, /^\/ctf_integration_[a-f0-9]{32}$/);
const database = `ctf_integration_${randomUUID().replaceAll("-", "")}`;
const adminUrl = new URL(base);
adminUrl.pathname = "/postgres";

test("Flag route accepts bounded live capabilities only", { timeout: 30_000 }, async (t) => {
  const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
  await admin.query(`CREATE DATABASE "${database}"`);
  const url = new URL(base);
  url.pathname = `/${database}`;
  const pool = new Pool({
    connectionString: url.toString(),
    max: 5,
    options: "-c search_path=ctf,public",
  });
  (globalThis as typeof globalThis & { ctfPool?: Pool }).ctfPool = pool;
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE "${database}"`);
    await admin.end();
  });
  for (const file of [
    "schema.sql",
    "migrations/002-dollar-seasons.sql",
    "migrations/003-monitor-reasoning.sql",
    "migrations/005-estimated-settlement.sql",
    "migrations/006-system-prompt.sql",
    "migrations/007-inference-game-index.sql",
    "migrations/008-block-ends-run.sql",
    "migrations/009-monitor-choice.sql",
    "migrations/010-control-monitor.sql",
    "migrations/011-agent-effort.sql",
    "migrations/012-new-run.sql",
    "migrations/013-agent-sessions.sql",
    "migrations/014-async-monitor.sql",
    "migrations/015-transcript-evidence.sql",
    "migrations/018-monitor-ready.sql",
    "migrations/019-session-stop.sql",
    "migrations/020-http-flag-submission.sql",
  ])
    await pool.query(await readFile(new URL(`../../db/${file}`, import.meta.url), "utf8"));
  process.env.BETTER_AUTH_SECRET = "integration-only-secret-long-enough-for-better-auth";
  process.env.BETTER_AUTH_URL = "https://flags.integration.test";
  process.env.SITE_URL = "https://flags.integration.test";
  const { auth } = await import("../../lib/auth");
  const { getMigrations } = await import("better-auth/db/migration");
  await (await getMigrations(auth.options)).runMigrations();
  const signedIn = await auth.api.signInAnonymous({ returnHeaders: true });
  const ownerId = signedIn.response!.user.id;
  await pool.query(`UPDATE ctf."user" SET "isAnonymous"=false WHERE id=$1`, [ownerId]);
  const cookie = signedIn.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  assert.equal((await auth.api.getSession({ headers: new Headers({ cookie }) }))?.user.id, ownerId);
  const { hashSecret } = await import("../../lib/policy");
  const { hashSubmissionToken } = await import("../../lib/flag-submissions");
  const route = await import("../../app/v1/end/route");
  const gameId = randomUUID(),
    sessionId = randomUUID(),
    operationId = randomUUID(),
    lease = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const flag = `flag{${randomBytes(24).toString("base64url")}}`;
  await pool.query(
    `INSERT INTO ctf.games(id,owner_id,sprite_name,secret_hash,agent_model,monitor_model,monitor_version,
      status,token_budget,agent_effort,system_prompt,monitor_mode,submission_transport)
     VALUES($1,$2,$3,$4,'agent','monitor','version','active',1000,'medium','','async','http')`,
    [gameId, ownerId, `sprite-${gameId}`, hashSecret(flag)],
  );
  await pool.query(
    `INSERT INTO ctf.agent_sessions(id,game_id,ordinal,agent_model,agent_effort,system_prompt,lease,lease_until)
     VALUES($1,$2,1,'agent','medium','',$3,now()+interval '1 minute')`,
    [sessionId, gameId, lease],
  );
  await pool.query(
    `INSERT INTO ctf.sprite_operations(id,sprite_name,game_id,session_id,tool_call_id,kind,command,
      execution_generation,submission_token_hash,originating_lease)
     VALUES($1,$2,$3,$4,'call','command','curl',0,$5,$6)`,
    [operationId, `sprite-${gameId}`, gameId, sessionId, hashSubmissionToken(token), lease],
  );
  const endpoint = "https://flags.integration.test/v1/end";
  const submit = (body: BodyInit, headers: Record<string, string> = {}, target = endpoint) =>
    route.POST(
      new Request(target, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          Authorization: `Bearer ${token}`,
          "X-CTF-Run-Id": gameId,
          Host: "flags.integration.test",
          ...headers,
        },
        body,
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
    );
  const cookieOnly = await route.POST(
    new Request(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-CTF-Run-Id": gameId,
        Host: "flags.integration.test",
        Cookie: cookie,
      },
      body: flag,
    }),
  );
  assert.equal(cookieOnly.status, 401);
  const first = await submit(flag);
  assert.equal(first.status, 202);
  assert.equal(first.headers.get("cache-control"), "no-store");
  const ack = await first.text();
  assert.equal(ack.includes(flag), false);
  assert.equal((await submit(flag)).status, 202);
  assert.equal((await submit("different")).status, 409);
  assert.equal(
    (await submit(flag, { Authorization: `Bearer ${token}, Bearer ${token}` })).status,
    401,
  );
  assert.equal((await submit(flag, { "X-CTF-Run-Id": `${gameId}, ${gameId}` })).status, 401);
  assert.equal(
    (await submit(flag, { "Content-Type": "application/octet-stream, application/octet-stream" }))
      .status,
    415,
  );
  assert.equal((await submit(flag, {}, `${endpoint}?x=1`)).status, 404);
  const localNextUrl = "https://localhost:3001/v1/end";
  assert.equal((await submit(flag, {}, localNextUrl)).status, 202);
  assert.equal((await submit(flag, { Host: "other.integration.test" }, localNextUrl)).status, 400);
  assert.equal(
    (await submit(flag, { Host: "flags.integration.test:443" }, localNextUrl)).status,
    400,
  );
  assert.equal(
    (await submit(flag, { Host: "flags.integration.test, other.test" }, localNextUrl)).status,
    400,
  );
  assert.equal(
    (
      await route.POST(
        new Request(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            Authorization: `Bearer ${token}`,
            "X-CTF-Run-Id": gameId,
          },
          body: flag,
        }),
      )
    ).status,
    400,
  );
  assert.equal((await submit(flag, {}, "http://localhost:3001/v1/end")).status, 400);
  assert.equal(
    (
      await submit(
        flag,
        { Host: "other.integration.test" },
        "https://other.integration.test/v1/end",
      )
    ).status,
    400,
  );
  assert.equal((await submit(flag, { "X-Forwarded-Host": "other.integration.test" })).status, 202);
  assert.equal(
    (await submit(flag, { "X-Forwarded-Host": "other.integration.test" }, localNextUrl)).status,
    202,
  );
  assert.equal((await submit(flag, { "X-Forwarded-Proto": "http" })).status, 202);
  assert.equal((await route.OPTIONS()).status, 405);
  assert.equal((await route.GET()).status, 405);
  assert.equal((await route.HEAD()).status, 405);
  assert.equal((await route.PUT()).status, 405);
  assert.equal((await route.PATCH()).status, 405);
  assert.equal((await route.DELETE()).status, 405);
  assert.equal((await submit(flag, { Host: "other.integration.test" })).status, 400);
  assert.equal(
    (
      await pool.query("SELECT count(*)::int AS n FROM ctf.flag_submissions WHERE game_id=$1", [
        gameId,
      ])
    ).rows[0].n,
    1,
  );
});

test("Flag route rejects bad and stalled Web streams", { timeout: 15_000 }, async () => {
  process.env.SITE_URL = "https://flags.integration.test";
  const route = await import("../../app/v1/end/route");
  const endpoint = "https://flags.integration.test/v1/end";
  const gameId = randomUUID();
  const headers = {
    "Content-Type": "application/octet-stream",
    Authorization: "Bearer synthetic-token",
    "X-CTF-Run-Id": gameId,
    Host: "flags.integration.test",
  };
  const request = (stream: ReadableStream<Uint8Array>) =>
    new Request(endpoint, {
      method: "POST",
      headers,
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
  const oversized = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.alloc(5000));
      controller.enqueue(Buffer.alloc(3193));
      controller.close();
    },
  });
  assert.equal((await route.POST(request(oversized))).status, 413);
  const malformed = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.from([0xff]));
      controller.close();
    },
  });
  assert.equal((await route.POST(request(malformed))).status, 400);
  let cancelled = false;
  const stalled = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>(() => {});
    },
    cancel() {
      cancelled = true;
    },
  });
  const slow = await route.POST(request(stalled));
  assert.equal(slow.status, 408);
  assert.equal(cancelled, true);
  const aborter = new AbortController();
  let abortCancelled = false;
  const aborted = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>(() => {});
    },
    cancel() {
      abortCancelled = true;
    },
  });
  const pending = route.POST(
    new Request(endpoint, {
      method: "POST",
      headers,
      body: aborted,
      signal: aborter.signal,
      duplex: "half",
    } as RequestInit & { duplex: "half" }),
  );
  setTimeout(() => aborter.abort(), 20);
  assert.equal((await pending).status, 400);
  assert.equal(abortCancelled, true);
});
