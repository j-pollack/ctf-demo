import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Pool } from "pg";

// Only the runner's fresh loopback container is accepted; never read .env.local.
const runner = new URL(process.env.CTF_INTEGRATION_DATABASE_URL ?? "http://missing");
assert.equal(runner.hostname, "127.0.0.1", "Use npm run test:integration");
assert.match(runner.pathname, /^\/ctf_integration_[a-f0-9]{32}$/);
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

await test("the admin-set game rules are stored, validated and authorised", async (t) => {
  t.after(() => pool.end());
  const sql = (file: string) => readFile(new URL(`../../db/${file}`, import.meta.url), "utf8");
  await pool.query(await sql("schema.sql"));
  await pool.query(await sql("migrations/017-settings.sql"));
  for (let pass = 0; pass < 2; pass++) await pool.query(await sql("migrations/021-game-rules.sql"));
  const columns = (
    await pool.query(
      `SELECT column_name,column_default,is_nullable FROM information_schema.columns
       WHERE table_schema='ctf' AND table_name='games'
         AND column_name IN ('monitor_isolation','bug_fix_required') ORDER BY column_name`,
    )
  ).rows;
  assert.deepEqual(
    columns.map((c) => [c.column_name, c.column_default, c.is_nullable]),
    [
      ["bug_fix_required", "true", "NO"],
      ["monitor_isolation", "false", "NO"],
    ],
    "applying the migration twice succeeds and adds both columns with their defaults",
  );

  process.env.BETTER_AUTH_SECRET = "integration-only-secret-long-enough-for-better-auth";
  process.env.BETTER_AUTH_URL = "http://localhost";
  const { auth } = await import("../../lib/auth");
  await (
    await (await import("better-auth/db/migration")).getMigrations(auth.options)
  ).runMigrations();
  const { GameError } = await import("../../lib/policy");
  const { currentGameRules } = await import("../../lib/game-rules");
  const { changeGameRule, gameRuleSettings } = await import("../../lib/game-rules-admin");
  const defaults = { monitorIsolation: false, bugFixRequired: true, jailbreakCatch: false };

  const signIn = async (flags: { member?: boolean; admin?: boolean }) => {
    const { headers, response } = await auth.api.signInAnonymous({ returnHeaders: true });
    const id = response!.user.id;
    if (flags.member)
      await pool.query(`UPDATE ctf."user" SET "isAnonymous"=false,email=$2 WHERE id=$1`, [
        id,
        `${id}@example.invalid`,
      ]);
    if (flags.admin) await pool.query(`UPDATE ctf."user" SET "isAdmin"=true WHERE id=$1`, [id]);
    const cookie = headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    return { id, headers: new Headers({ cookie }) };
  };
  const rows = async () => (await pool.query("SELECT * FROM ctf.settings ORDER BY key")).rows;
  const refused = (status: number) => (error: unknown) =>
    error instanceof GameError && error.status === status;

  await t.test(
    "S1: no row, or a stored value other than on or off, gives the default",
    async () => {
      assert.deepEqual(await currentGameRules(), defaults);
      await pool.query(
        `INSERT INTO ctf.settings(key,value) VALUES('monitor_isolation','maybe'),('bug_fix_required','')`,
      );
      assert.deepEqual(await currentGameRules(), defaults);
      await pool.query("DELETE FROM ctf.settings");
    },
  );

  await t.test(
    "S2: anyone who is not a signed-in admin is refused and nothing changes",
    async () => {
      const guest = await signIn({});
      const adminGuest = await signIn({ admin: true });
      const member = await signIn({ member: true });
      for (const who of [new Headers(), guest.headers, adminGuest.headers, member.headers])
        for (const key of ["monitor_isolation", "jailbreak_catch"])
          await assert.rejects(changeGameRule(who, key, "on"), refused(404));
      assert.deepEqual(await rows(), []);
      assert.deepEqual(await currentGameRules(), defaults);
    },
  );

  const owner = await signIn({ member: true, admin: true });
  await t.test("S2: an admin's invalid key or value is refused and nothing changes", async () => {
    for (const key of [null, undefined, 7, "", "agent_model", "monitorIsolation"])
      await assert.rejects(changeGameRule(owner.headers, key, "on"), refused(400));
    for (const value of [null, undefined, true, "", "ON", "yes"])
      await assert.rejects(changeGameRule(owner.headers, "bug_fix_required", value), refused(400));
    assert.deepEqual(await rows(), []);
  });

  await t.test("S2: an admin's change is stored with who and when, and read back", async () => {
    assert.deepEqual(await gameRuleSettings(), {});
    await changeGameRule(owner.headers, "monitor_isolation", "on");
    await changeGameRule(owner.headers, "bug_fix_required", "off");
    await changeGameRule(owner.headers, "jailbreak_catch", "on");
    const stored = await rows();
    assert.deepEqual(
      stored.map((row) => [row.key, row.value, row.updated_by]),
      [
        ["bug_fix_required", "off", owner.id],
        ["jailbreak_catch", "on", owner.id],
        ["monitor_isolation", "on", owner.id],
      ],
    );
    assert.deepEqual(await currentGameRules(), {
      monitorIsolation: true,
      bugFixRequired: false,
      jailbreakCatch: true,
    });
    const settings = await gameRuleSettings();
    assert.deepEqual(
      Object.entries(settings).map(([key, who]) => [key, who.updatedBy]),
      [
        ["bug_fix_required", `${owner.id}@example.invalid`],
        ["jailbreak_catch", `${owner.id}@example.invalid`],
        ["monitor_isolation", `${owner.id}@example.invalid`],
      ],
    );
    await changeGameRule(owner.headers, "monitor_isolation", "off");
    assert.equal((await rows()).length, 3, "a second change replaces the row");
    assert.deepEqual(await currentGameRules(), {
      monitorIsolation: false,
      bugFixRequired: false,
      jailbreakCatch: true,
    });
  });

  await t.test("W6: no admin read returns the idle worker's registration", async () => {
    const { agentModelSetting, currentAgentModel } = await import("../../lib/agent-model");
    const token = "worker-wake-token-that-must-not-leak";
    await pool.query(`INSERT INTO ctf.settings(key,value) VALUES('worker_wake',$1)`, [
      JSON.stringify({ url: "http://127.0.0.1:1/wake", instance: null, token }),
    ]);
    const reads = [
      await gameRuleSettings(),
      await currentGameRules(),
      await agentModelSetting(),
      await currentAgentModel(),
    ];
    for (const read of reads) {
      assert.ok(!JSON.stringify(read ?? null).includes(token));
      assert.ok(!JSON.stringify(read ?? null).includes("worker_wake"));
    }
    await pool.query("DELETE FROM ctf.settings WHERE key='worker_wake'");
  });
});
