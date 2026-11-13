import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Pool } from "pg";

// Only the runner's fresh loopback container is accepted; never read .env.local.
const runner = new URL(process.env.CTF_INTEGRATION_DATABASE_URL ?? "http://missing");
assert.equal(runner.hostname, "127.0.0.1", "Use npm run test:integration");
assert.match(runner.pathname, /^\/ctf_integration_[a-f0-9]{32}$/);
// Own database in the same container, so this file never races the Sprite suite's schema.
const name = `ctf_integration_${randomUUID().replaceAll("-", "")}`;
const admin = new Pool({ connectionString: runner.toString(), max: 1 });
await admin.query(`CREATE DATABASE ${name}`);
await admin.end();
const connection = new URL(runner);
connection.pathname = `/${name}`;
const pool = new Pool({
  connectionString: connection.toString(),
  max: 5,
  options: "-c search_path=ctf,public",
});
(globalThis as typeof globalThis & { ctfPool?: Pool }).ctfPool = pool;

await test("admin stats aggregate real persisted rows", async (t) => {
  t.after(() => pool.end());
  for (const file of [
    "../../db/schema.sql",
    "../../db/migrations/002-dollar-seasons.sql",
    "../../db/migrations/003-monitor-reasoning.sql",
    "../../db/migrations/005-estimated-settlement.sql",
    "../../db/migrations/006-system-prompt.sql",
    "../../db/migrations/007-inference-game-index.sql",
    "../../db/migrations/008-block-ends-run.sql",
    "../../db/migrations/009-monitor-choice.sql",
    "../../db/migrations/010-control-monitor.sql",
    "../../db/migrations/011-agent-effort.sql",
    "../../db/migrations/012-new-run.sql",
  ])
    await pool.query(await readFile(new URL(file, import.meta.url), "utf8"));
  process.env.BETTER_AUTH_SECRET = "integration-only-secret-long-enough-for-better-auth";
  process.env.BETTER_AUTH_URL = "http://localhost";
  const { auth } = await import("../../lib/auth");
  const { getMigrations } = await import("better-auth/db/migration");
  await (await getMigrations(auth.options)).runMigrations();
  const { adminStats, isAdmin } = await import("../../lib/admin");
  const { MODELS } = await import("../../lib/policy");
  const { MONITOR_VERSION } = await import("../../lib/control");

  // The flag is SQL-granted only: real Better Auth handlers must refuse it from users.
  const signedIn = await auth.api.signInAnonymous({ returnHeaders: true });
  const session = new Headers({
    cookie: signedIn.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; "),
  });
  const userId = signedIn.response!.user.id;
  await assert.rejects(
    auth.api.updateUser({ headers: session, body: { isAdmin: true } as never }),
    /isAdmin is not allowed to be set/,
  );
  const flag = async () =>
    (await pool.query(`SELECT "isAdmin" FROM ctf."user" WHERE id=$1`, [userId])).rows[0].isAdmin;
  assert.notEqual(await flag(), true);
  assert.equal(isAdmin((await auth.api.getSession({ headers: session }))?.user), false);
  await pool.query(`UPDATE ctf."user" SET "isAdmin"=true WHERE id=$1`, [userId]);
  const granted = (await auth.api.getSession({ headers: session }))?.user;
  assert.equal(granted?.isAdmin, true);
  assert.equal(isAdmin(granted), false, "guests never qualify, even when flagged");
  await pool.query(`UPDATE ctf."user" SET "isAnonymous"=false WHERE id=$1`, [userId]);
  assert.equal(isAdmin((await auth.api.getSession({ headers: session }))?.user), true);
  await pool.query(`DELETE FROM ctf."session"; DELETE FROM ctf."user"`);

  // Budgets and run limits are per account, so every plus-variant must reach the same account.
  process.env.RESEND_API_KEY = "re_integration_only";
  process.env.RESEND_FROM = "ctf@example.invalid";
  const mail: { to: string; link: string }[] = [];
  const resend = t.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    assert.equal(String(input), "https://api.resend.com/emails");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer re_integration_only");
    const sent = JSON.parse(String(init?.body));
    mail.push({ to: String(sent.to), link: sent.text.match(/https?:\/\/\S+/)[0] });
    return Response.json({ id: randomUUID() });
  });
  const origin = "http://localhost";
  const request = (email: string) =>
    auth.handler(
      new Request(`${origin}/api/auth/sign-in/magic-link`, {
        method: "POST",
        headers: { origin, "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      }),
    );
  const accounts = [];
  for (const email of [
    "plus@example.invalid",
    "plus+1@example.invalid",
    "Plus+a+b@Example.invalid",
  ]) {
    assert.equal((await request(email)).status, 200);
    const verified = await auth.handler(new Request(mail.at(-1)!.link));
    assert.equal(verified.status, 302);
    const cookie = verified.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    accounts.push((await auth.api.getSession({ headers: new Headers({ cookie }) }))?.user.id);
  }
  assert.ok(accounts[0]);
  assert.deepEqual(accounts, [accounts[0], accounts[0], accounts[0]]);
  assert.deepEqual(
    mail.map((sent) => sent.to),
    Array(3).fill("plus@example.invalid"),
  );
  assert.deepEqual((await pool.query(`SELECT email FROM ctf."user"`)).rows, [
    { email: "plus@example.invalid" },
  ]);
  assert.equal((await request("+1@example.invalid")).status, 400);
  assert.equal(mail.length, 3, "an address with nothing before the plus sends no email");
  resend.mock.restore();
  await pool.query(
    `DELETE FROM ctf."session"; DELETE FROM ctf."verification"; DELETE FROM ctf."user"`,
  );

  const empty = await adminStats();
  assert.equal(empty.totals.runs, 0);
  assert.equal(empty.totals.spend_avg, 0);
  assert.equal(empty.daily.length, 30);

  const user = (id: string, email: string, anonymous: boolean, created: string) =>
    pool.query(
      `INSERT INTO ctf."user"(id,name,email,"emailVerified","isAnonymous","createdAt","updatedAt") VALUES($1,$1,$2,true,$3,$4,$4)`,
      [id, email, anonymous, created],
    );
  await user("m1", "one@example.invalid", false, "2026-08-15T00:00:00Z");
  await user("m2", "two@example.invalid", false, "2026-09-02T00:00:00Z");
  await user("g1", "temp@guest.invalid", true, "2026-09-03T00:00:00Z");
  const game = (
    owner: string,
    status: string,
    spent: number,
    reserved = 0,
    turns = 4,
    blocks = 1,
    pick: { monitor?: string; difficulty?: string; version?: string } = {},
  ) =>
    pool
      .query(
        `INSERT INTO ctf.games(id,owner_id,sprite_name,secret_hash,agent_model,monitor_model,monitor_version,monitor_difficulty,status,token_budget,spent_microdollars,reserved_microdollars,turns,blocks)
        VALUES($1::uuid,$2,$1::text,'h','agent/a',$8,$9,$10,$3,1000,$4,$5,$6,$7) RETURNING id`,
        [
          randomUUID(),
          owner,
          status,
          spent,
          reserved,
          turns,
          blocks,
          pick.monitor ?? "mon/a",
          pick.version ?? MONITOR_VERSION,
          pick.difficulty ?? "hard",
        ],
      )
      .then((r) => r.rows[0].id as string);
  const captured = await game("m1", "captured", 1_000_000);
  await game("m1", "exhausted", 3_000_000, 0, 10, 5);
  await game("g1", "active", 200_000, 50_000, 2, 0);
  await pool.query(
    `INSERT INTO ctf.daily_spend(day,charged,reserved) VALUES((now() AT TIME ZONE 'UTC')::date,4200000,50000)`,
  );
  await pool.query(
    `INSERT INTO ctf.inference(id,game_id,day,role,model,token_ceiling,cost_ceiling,tokens,cost,settled_at,estimated)
    VALUES($1,$3,(now() AT TIME ZONE 'UTC')::date,'agent','agent/a',100,900000,80,700000,now(),false),
          ($2,$3,(now() AT TIME ZONE 'UTC')::date,'monitor','mon/a',50,300000,NULL,NULL,NULL,false)`,
    [randomUUID(), randomUUID(), captured],
  );

  const s = await adminStats();
  assert.deepEqual(
    {
      members: s.totals.members,
      guests: s.totals.guests,
      runs: s.totals.runs,
      captures: s.totals.captures,
      open: s.totals.open_runs,
      players: s.totals.players,
      spend: s.totals.spend,
      reserved: s.totals.reserved,
      max: s.totals.spend_max,
      p50: s.totals.spend_p50,
      perCapture: s.totals.spend_per_capture,
      turns: s.totals.turns,
      blocks: s.totals.blocks,
    },
    {
      members: 2,
      guests: 1,
      runs: 3,
      captures: 1,
      open: 1,
      players: 2,
      spend: 4_200_000,
      reserved: 50_000,
      max: 3_000_000,
      p50: 1_000_000,
      perCapture: 1_000_000,
      turns: 16,
      blocks: 6,
    },
  );
  const today = s.daily.at(-1);
  assert.deepEqual(
    { runs: today.runs, captures: today.captures, players: today.players, spend: today.spend },
    { runs: 3, captures: 1, players: 2, spend: 4_200_000 },
  );
  assert.deepEqual(
    s.monthly.map((m) => [m.month, m.members, m.guests]),
    [
      ["2026-09", 1, 1],
      ["2026-08", 1, 0],
    ],
  );
  assert.deepEqual(
    s.models.map((m) => [m.role, m.calls, m.tokens, m.spend, m.pending]),
    [
      ["agent", 1, 80, 700_000, 0],
      ["monitor", 1, 0, 0, 1],
    ],
  );
  assert.deepEqual(
    s.spenders.map((x) => [x.who, x.guest, x.runs, x.spend]),
    [
      ["one@example.invalid", false, 2, 4_000_000],
      ["temp@guest.invalid", true, 1, 200_000],
    ],
  );

  // A fork inherits its parent's spend and turns: count it as a run, but sum those once. Blocks
  // are each run's own, so they sum over every run.
  const base = (await adminStats()).totals;
  const parentRun = await game("m2", "blocked", 400_000, 0, 3, 1);
  const childRun = await game("m2", "captured", 700_000, 0, 5, 0);
  await pool.query(
    "UPDATE ctf.games SET agent_model=$3,forked_from=CASE WHEN id=$2 THEN $1::uuid END WHERE id IN ($1,$2)",
    [parentRun, childRun, MODELS[0]],
  );
  await pool.query(
    `INSERT INTO ctf.inference(id,game_id,day,role,model,token_ceiling,cost_ceiling,tokens,cost,settled_at)
    VALUES($1,$2,(now() AT TIME ZONE 'UTC')::date,'agent','other/model',10,10,10,400000,now())`,
    [randomUUID(), parentRun],
  );
  const forked = await adminStats();
  assert.deepEqual(
    {
      runs: forked.totals.runs - base.runs,
      captures: forked.totals.captures - base.captures,
      spend: forked.totals.spend - base.spend,
      turns: forked.totals.turns - base.turns,
      blocks: forked.totals.blocks - base.blocks,
    },
    { runs: 2, captures: 1, spend: 700_000, turns: 5, blocks: 1 },
  );
  assert.equal(forked.outcomes.find((x) => x.status === "blocked")?.spend, 0);
  assert.equal(forked.spenders.find((x) => x.who === "two@example.invalid")?.spend, 700_000);

  await user("m3", "three@example.invalid", false, "2026-09-04T00:00:00Z");
  // Runs against another monitor model and difficulty; one against an old monitor version never ranks.
  await game("m3", "captured", 500_000, 0, 2, 0, { monitor: "mon/b" });
  await game("m3", "captured", 400_000, 0, 3, 0, { difficulty: "easy" });
  await game("m3", "captured", 100_000, 0, 1, 0, { version: "secret-v1" });
  await game("m3", "captured", 300_000, 0, 5, 0, { monitor: "mon/c" });

  await t.test("capture rate is grouped by monitor model and difficulty", async () => {
    const stats = await adminStats();
    assert.ok(!("seasons" in stats));
    assert.deepEqual(
      stats.monitors.map((x) => [
        x.monitor_model,
        x.monitor_difficulty,
        x.runs,
        x.captures,
        x.spend,
      ]),
      [
        ["mon/a", "hard", 6, 3, 5_000_000],
        ["mon/a", "easy", 1, 1, 400_000],
        ["mon/b", "hard", 1, 1, 500_000],
        ["mon/c", "hard", 1, 1, 300_000],
      ],
    );
  });

  await t.test("the leaderboard ranks one difficulty at a time, current monitor only", async () => {
    // The agent filter looks at the whole lineage's inference, not just the last run.
    const { GET } = await import("../../app/api/leaderboard/route");
    const get = async (query: string) =>
      (await (await GET(new Request(`http://localhost/api/leaderboard${query}`))).json()) as {
        entries: { spend: number; monitor_reasoning: boolean }[];
      };
    const spends = async (query: string) => (await get(query)).entries.map((x) => x.spend);
    // Each player's cheapest capture; m3's cheaper old-version capture (100_000) never ranks.
    assert.deepEqual(await spends(""), [300_000, 700_000, 1_000_000], "defaults to hard");
    assert.deepEqual(
      await spends("?difficulty=hard&agent="),
      [300_000, 700_000, 1_000_000],
      "an empty agent filter, as the board sends for Any, ranks every agent",
    );
    assert.deepEqual(await spends("?difficulty=easy"), [400_000]);
    assert.deepEqual(await spends("?difficulty=medium"), []);
    assert.deepEqual(await spends("?difficulty=extreme"), [], "an unknown difficulty is empty");
    assert.deepEqual(await spends("?agent=not%2Fa-model"), [], "an unknown agent is empty");
    const body = await get("");
    assert.ok(!("seasons" in body) && !("currentSeasonId" in body));
    assert.equal(body.entries.find((x) => x.spend === 700_000)?.monitor_reasoning, true);
    // The agent filter excludes a lineage that used another agent model for any turn.
    const mine = async (agent: string) =>
      (await spends(`?agent=${encodeURIComponent(agent)}`)).filter((x) => x === 700_000);
    assert.equal(await mine(MODELS[0]).then((x) => x.length), 0);
    await pool.query("UPDATE ctf.inference SET model=$2 WHERE game_id=$1", [parentRun, MODELS[0]]);
    assert.equal(await mine(MODELS[0]).then((x) => x.length), 1);
  });
});
