import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Pool } from "pg";

// Only the runner's fresh loopback container is accepted; never read .env.local.
const base = new URL(process.env.CTF_INTEGRATION_DATABASE_URL ?? "http://missing");
assert.equal(base.hostname, "127.0.0.1", "Use npm run test:integration");
assert.match(base.pathname, /^\/ctf_integration_[a-f0-9]{32}$/);
const database = `ctf_integration_${randomUUID().replaceAll("-", "")}`;
const adminUrl = new URL(base);
adminUrl.pathname = "/postgres";

const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");
const MIGRATION = "036-feedback.sql";

test("feedback messages and run reports", { timeout: 120_000 }, async (t) => {
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
  // Same order as scripts/setup.ts: game migrations, Better Auth, then the ones that adjust its tables.
  const setup = await read("../../scripts/setup.ts");
  const listed = [...setup.matchAll(/"(\d{3}-[\w-]+\.sql)"/g)].map((match) => match[1]);
  const afterAuth = ["004-rate-limit-timestamp.sql", "033-display-name.sql"];
  await pool.query(await read("../../db/schema.sql"));
  for (const file of listed.filter((file) => !afterAuth.includes(file)))
    await pool.query(await read(`../../db/migrations/${file}`));
  process.env.BETTER_AUTH_SECRET = "integration-only-secret-long-enough-for-better-auth";
  process.env.BETTER_AUTH_URL = "https://feedback.integration.test";
  process.env.SITE_URL = "https://feedback.integration.test";
  const { auth } = await import("../../lib/auth");
  const { getMigrations } = await import("better-auth/db/migration");
  await (await getMigrations(auth.options)).runMigrations();
  for (const file of afterAuth) await pool.query(await read(`../../db/migrations/${file}`));

  await t.test("F12: migration 036 applies twice and setup and runbook name it", async () => {
    const sql = await read(`../../db/migrations/${MIGRATION}`);
    await pool.query(sql);
    await pool.query(sql);
    assert.ok(listed.includes(MIGRATION), "setup lists 036");
    assert.ok(
      setup.indexOf(MIGRATION) < setup.indexOf("runMigrations()"),
      "036 is a game migration and runs before Better Auth",
    );
    assert.match(await read("../../deploy/operations.md"), /036-feedback/);
  });

  // The only external boundary is Resend, and this feature sends no email.
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    throw new Error(`Unexpected external request: ${String(input)}`);
  });
  const { POST } = await import("../../app/api/feedback/route");
  const origin = "https://feedback.integration.test";

  const signIn = async (member: boolean) => {
    const signedIn = await auth.api.signInAnonymous({ returnHeaders: true });
    const id = signedIn.response!.user.id;
    if (member) await pool.query(`UPDATE ctf."user" SET "isAnonymous"=false WHERE id=$1`, [id]);
    const cookie = signedIn.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    return { id, cookie };
  };
  const insertRun = async (ownerId: string, sessions: number) => {
    const gameId = randomUUID();
    await pool.query(
      `INSERT INTO ctf.games(id,owner_id,sprite_name,secret_hash,agent_model,monitor_model,monitor_version,
        status,token_budget,agent_effort,system_prompt,monitor_mode,submission_transport)
       VALUES($1,$2,$3,$4,'agent','monitor','version','active',1000,'medium','','async','http')`,
      [gameId, ownerId, `sprite-${gameId}`, "hash"],
    );
    const ids: string[] = [];
    for (let ordinal = 1; ordinal <= sessions; ordinal++) {
      const id = ordinal === 1 ? gameId : randomUUID();
      ids.push(id);
      await pool.query(
        `INSERT INTO ctf.agent_sessions(id,game_id,ordinal,agent_model,agent_effort,system_prompt)
         VALUES($1,$2,$3,'agent','medium','')`,
        [id, gameId, ordinal],
      );
    }
    return { gameId, sessions: ids };
  };
  const post = async (
    payload: unknown,
    {
      cookie,
      ip,
      headers,
    }: { cookie?: string; ip?: string; headers?: Record<string, string> } = {},
  ) => {
    const response = await POST(
      new Request(`${origin}/api/feedback`, {
        method: "POST",
        headers: {
          origin,
          "Content-Type": "application/json",
          ...(cookie ? { cookie } : {}),
          ...(ip ? { "x-forwarded-for": ip } : {}),
          ...headers,
        },
        body: typeof payload === "string" ? payload : JSON.stringify(payload),
      }),
    );
    return { status: response.status, body: await response.json() };
  };
  const rows = async () =>
    (await pool.query("SELECT * FROM ctf.feedback ORDER BY created_at")).rows;
  t.beforeEach(() => pool.query("DELETE FROM ctf.feedback"));

  const contact = { kind: "contact", name: " Ada ", email: "ada@example.com", message: " Hello " };
  const alice = await signIn(true);
  const bob = await signIn(true);
  const guest = await signIn(false);
  const aliceRun = await insertRun(alice.id, 2);
  const bobRun = await insertRun(bob.id, 1);

  await t.test("F1: a signed-out contact message is stored trimmed with no owner", async () => {
    assert.deepEqual(await post(contact, { ip: "198.51.100.1" }), {
      status: 200,
      body: { ok: true },
    });
    const [row, ...rest] = await rows();
    assert.equal(rest.length, 0);
    assert.equal(row.kind, "contact");
    assert.equal(row.name, "Ada");
    assert.equal(row.email, "ada@example.com");
    assert.equal(row.message, "Hello");
    assert.equal(row.user_id, null);
    assert.equal(row.game_id, null);
    assert.equal(row.session_id, null);
  });

  await t.test(
    "F2: a member's contact message records the account, a guest's does not",
    async () => {
      assert.equal((await post(contact, { cookie: alice.cookie, ip: "198.51.100.2" })).status, 200);
      assert.equal((await post(contact, { cookie: guest.cookie, ip: "198.51.100.3" })).status, 200);
      assert.deepEqual(
        (await rows()).map((row) => row.user_id),
        [alice.id, null],
      );
    },
  );

  await t.test("F3: invalid bodies get 400 and write nothing", async () => {
    const run = aliceRun.gameId;
    const bad: unknown[] = [
      {},
      { ...contact, kind: "nope" },
      { ...contact, name: "" },
      { ...contact, name: "a".repeat(101) },
      { ...contact, email: "not an email" },
      { ...contact, message: "   " },
      { ...contact, message: "a".repeat(5001) },
      { ...contact, gameId: run },
      { ...contact, sessionId: run },
      { kind: "bug", message: "x" },
      { kind: "bug", gameId: "nope", message: "x" },
      { kind: "bug", gameId: run, sessionId: "nope", message: "x" },
      "[]",
      "not json",
    ];
    for (const payload of bad) {
      assert.equal(
        (await post(payload, { cookie: alice.cookie })).status,
        400,
        JSON.stringify(payload),
      );
    }
    assert.equal(
      (await post({ kind: "bug", message: "x" })).status,
      400,
      "an invalid report is a 400 before the sign-in check",
    );
    assert.deepEqual(await rows(), []);
  });

  await t.test("F4: a missing or foreign Origin gets 403 and writes nothing", async () => {
    const noOrigin = new Request(`${origin}/api/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(contact),
    });
    assert.equal((await POST(noOrigin)).status, 403);
    assert.equal(
      (await post(contact, { headers: { origin: "https://evil.example" } })).status,
      403,
    );
    assert.deepEqual(await rows(), []);
  });

  await t.test("F5: a signed-out or guest report gets 401 and writes nothing", async () => {
    const report = { kind: "bug", gameId: aliceRun.gameId, message: "x" };
    assert.equal((await post(report)).status, 401);
    assert.equal((await post(report, { cookie: guest.cookie })).status, 401);
    assert.deepEqual(await rows(), []);
  });

  await t.test("F6: an owner's report stores the run and the session when given", async () => {
    const [first, second] = aliceRun.sessions;
    const withSession = {
      kind: "monitor",
      gameId: aliceRun.gameId,
      sessionId: second,
      message: " It was wrong ",
    };
    assert.equal((await post(withSession, { cookie: alice.cookie })).status, 200);
    assert.equal(
      (
        await post(
          { kind: "bug", gameId: aliceRun.gameId, message: "Broken" },
          { cookie: alice.cookie },
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await post(
          { kind: "other", gameId: aliceRun.gameId, sessionId: first, message: "Hm" },
          { cookie: alice.cookie },
        )
      ).status,
      200,
    );
    const stored = await rows();
    assert.deepEqual(
      stored.map((row) => [row.kind, row.message, row.user_id, row.game_id, row.session_id]),
      [
        ["monitor", "It was wrong", alice.id, aliceRun.gameId, second],
        ["bug", "Broken", alice.id, aliceRun.gameId, null],
        ["other", "Hm", alice.id, aliceRun.gameId, first],
      ],
    );
  });

  await t.test("F7: another member's run or a foreign session gets 404", async () => {
    const attempts = [
      { kind: "bug", gameId: bobRun.gameId, message: "x" },
      { kind: "bug", gameId: bobRun.gameId, sessionId: bobRun.sessions[0], message: "x" },
      { kind: "bug", gameId: aliceRun.gameId, sessionId: bobRun.sessions[0], message: "x" },
      { kind: "bug", gameId: aliceRun.gameId, sessionId: randomUUID(), message: "x" },
      { kind: "bug", gameId: randomUUID(), message: "x" },
    ];
    for (const attempt of attempts)
      assert.equal(
        (await post(attempt, { cookie: alice.cookie })).status,
        404,
        JSON.stringify(attempt),
      );
    assert.deepEqual(await rows(), []);
  });

  await t.test("F8: five messages an hour per address, IPv6 grouped by prefix", async () => {
    for (let i = 0; i < 5; i++)
      assert.equal((await post(contact, { ip: "203.0.113.7" })).status, 200);
    const sixth = await post(contact, { ip: "203.0.113.7" });
    assert.deepEqual(sixth, {
      status: 429,
      body: { error: "Too many messages. Try again later." },
    });
    assert.equal((await rows()).length, 5);
    assert.equal((await post(contact, { ip: "203.0.113.8" })).status, 200);
    await pool.query("DELETE FROM ctf.feedback");
    for (let i = 0; i < 5; i++)
      assert.equal((await post(contact, { ip: `2001:db8:1:2:${i}::${i}` })).status, 200);
    assert.equal((await post(contact, { ip: "2001:db8:1:2:ffff::1" })).status, 429);
    assert.equal((await post(contact, { ip: "2001:db8:1:3::1" })).status, 200);
  });

  await t.test("F8: eight parallel messages from one address admit exactly five", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => post(contact, { ip: "203.0.113.40" })),
    );
    const statuses = results.map((result) => result.status);
    assert.equal(statuses.filter((status) => status === 200).length, 5);
    assert.equal(statuses.filter((status) => status === 429).length, 3);
    assert.equal((await rows()).length, 5);
  });

  await t.test("F8: an hour later the same address is accepted again", async () => {
    for (let i = 0; i < 5; i++) await post(contact, { ip: "203.0.113.20" });
    assert.equal((await post(contact, { ip: "203.0.113.20" })).status, 429);
    await pool.query("UPDATE ctf.feedback SET created_at=now()-interval '61 minutes'");
    assert.equal((await post(contact, { ip: "203.0.113.20" })).status, 200);
  });

  await t.test("F9: ten reports an hour per member", async () => {
    const report = { kind: "bug", gameId: aliceRun.gameId, message: "x" };
    for (let i = 0; i < 10; i++)
      assert.equal((await post(report, { cookie: alice.cookie })).status, 200);
    assert.equal((await post(report, { cookie: alice.cookie })).status, 429);
    assert.equal((await rows()).length, 10);
    assert.equal(
      (await post({ ...report, gameId: bobRun.gameId }, { cookie: bob.cookie })).status,
      200,
      "another member is unaffected",
    );
  });

  await t.test("F10: the daily contact limit spares members' reports", async () => {
    await pool.query(
      `INSERT INTO ctf.feedback(kind,name,email,message,sender)
       SELECT 'contact','n','n@example.com','m','ip:'||g FROM generate_series(1,200) g`,
    );
    assert.equal((await post(contact, { ip: "203.0.113.30" })).status, 429);
    assert.equal(
      (await post({ kind: "bug", gameId: aliceRun.gameId, message: "x" }, { cookie: alice.cookie }))
        .status,
      200,
    );
    await pool.query("UPDATE ctf.feedback SET created_at=now()-interval '25 hours'");
    assert.equal((await post(contact, { ip: "203.0.113.30" })).status, 200);
  });

  await t.test("F11: stored senders never contain the raw address", async () => {
    await post(contact, { ip: "203.0.113.99" });
    await post(contact);
    await post(
      { kind: "bug", gameId: aliceRun.gameId, message: "x" },
      { cookie: alice.cookie, ip: "203.0.113.98" },
    );
    const senders = (await rows()).map((row) => row.sender as string);
    assert.equal(senders.length, 3);
    assert.match(senders[0], /^ip:[0-9a-f]{64}$/);
    assert.equal(senders[1], "ip:unknown");
    assert.equal(senders[2], `user:${alice.id}`);
    assert.ok(senders.every((sender) => !sender.includes("203.0.113")));
  });

  await t.test(
    "F15: the admin list is newest first with account email and session ordinal",
    async () => {
      const { listFeedback } = await import("../../lib/feedback");
      await post(contact, { ip: "203.0.113.50" });
      await post(
        {
          kind: "monitor",
          gameId: aliceRun.gameId,
          sessionId: aliceRun.sessions[1],
          message: "Wrong",
        },
        { cookie: alice.cookie },
      );
      const [report, message] = await listFeedback();
      assert.equal(report.kind, "monitor");
      assert.equal(report.gameId, aliceRun.gameId);
      assert.equal(report.sessionId, aliceRun.sessions[1]);
      assert.equal(report.ordinal, 2);
      assert.equal(
        report.accountEmail,
        (await pool.query(`SELECT email FROM ctf."user" WHERE id=$1`, [alice.id])).rows[0].email,
      );
      assert.equal(message.kind, "contact");
      assert.equal(message.ordinal, null);
      assert.equal(message.accountEmail, null);
      await pool.query(
        `INSERT INTO ctf.feedback(kind,name,email,message,sender)
       SELECT 'contact','n','n@example.com','m','ip:'||g FROM generate_series(1,60) g`,
      );
      assert.equal((await listFeedback()).length, 50);
    },
  );

  await t.test(
    "an unexpected route failure is logged with its cause; a refusal is not",
    async () => {
      const { errorResponse } = await import("../../lib/http");
      const { GameError } = await import("../../lib/policy");
      const lines: string[] = [];
      const logError = console.error;
      console.error = (line: unknown) => void lines.push(String(line));
      try {
        const failed = errorResponse(Object.assign(new Error("sandbox refused"), { code: "E42" }));
        assert.equal(failed.status, 503);
        assert.deepEqual(await failed.json(), {
          error: "The service could not complete this request. Try again.",
        });
        assert.equal(errorResponse(new GameError("Not found.", 404)).status, 404);
      } finally {
        console.error = logError;
      }
      assert.equal(lines.length, 1);
      const logged = JSON.parse(lines[0]);
      assert.equal(logged.event, "route.failed");
      assert.match(logged.error, /sandbox refused/);
      assert.equal(logged.code, "E42");
    },
  );
});
