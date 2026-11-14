import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Pool } from "pg";

// Only the runner's fresh loopback container is accepted; never read .env.local.
const runner = new URL(process.env.CTF_INTEGRATION_DATABASE_URL ?? "http://missing");
assert.equal(runner.hostname, "127.0.0.1", "Use npm run test:integration");
assert.match(runner.pathname, /^\/ctf_integration_[a-f0-9]{32}$/);
// Own database in the same container, so this file never races another suite's schema.
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

await test("the admin-set attacker model is stored, validated and authorised", async (t) => {
  const realFetch = globalThis.fetch;
  t.after(async () => {
    globalThis.fetch = realFetch;
    await pool.end();
  });
  const sql = (file: string) => readFile(new URL(`../../db/${file}`, import.meta.url), "utf8");
  await pool.query(await sql("schema.sql"));
  await pool.query(await sql("migrations/017-settings.sql"));
  await pool.query(await sql("migrations/017-settings.sql"));
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM ctf.settings")).rows[0].n,
    0,
    "applying the migration twice succeeds and adds no rows",
  );

  process.env.BETTER_AUTH_SECRET = "integration-only-secret-long-enough-for-better-auth";
  process.env.BETTER_AUTH_URL = "http://localhost";
  const { auth } = await import("../../lib/auth");
  await (
    await (await import("better-auth/db/migration")).getMigrations(auth.options)
  ).runMigrations();
  const { AGENT_MODEL, MODELS, GameError } = await import("../../lib/policy");
  const { agentModelSetting, changeAgentModel, currentAgentModel } =
    await import("../../lib/agent-model");

  // One catalog fixture: an allowlisted model that passes and one the catalog cannot serve.
  const accepted = MODELS.find((model) => model !== AGENT_MODEL)!;
  const unserved = MODELS.find((model) => model !== AGENT_MODEL && model !== accepted)!;
  const catalogRequests: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url !== "https://openrouter.ai/api/v1/models")
      throw new Error(`Unexpected request to ${url}`);
    catalogRequests.push(url);
    const entry = (id: string, supported_parameters: string[]) => ({
      id,
      context_length: 100000,
      pricing: { prompt: "0.000001", completion: "0.000002" },
      supported_parameters,
    });
    return Response.json({
      data: [
        entry(AGENT_MODEL, ["tools", "reasoning"]),
        entry(accepted, ["tools", "reasoning"]),
        entry(unserved, ["reasoning"]),
      ],
    });
  }) as typeof fetch;

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

  await t.test("no row, or a stored value outside the allowlist, gives the default", async () => {
    assert.equal(await currentAgentModel(), AGENT_MODEL);
    assert.equal(await agentModelSetting(), null);
    await pool.query("INSERT INTO ctf.settings(key,value) VALUES('agent_model','not/a-model')");
    assert.equal(await currentAgentModel(), AGENT_MODEL);
    await pool.query("DELETE FROM ctf.settings");
  });

  await t.test("anyone who is not a signed-in admin is refused and nothing changes", async () => {
    const guest = await signIn({});
    const adminGuest = await signIn({ admin: true });
    const member = await signIn({ member: true });
    for (const who of [new Headers(), guest.headers, adminGuest.headers, member.headers])
      await assert.rejects(changeAgentModel(who, accepted), refused(404));
    assert.deepEqual(await rows(), []);
    assert.equal(await currentAgentModel(), AGENT_MODEL);
  });

  const owner = await signIn({ member: true, admin: true });
  await t.test("an admin's invalid or unserved value is refused and nothing changes", async () => {
    for (const bad of [null, undefined, 7, {}, ["x"], "", "not/a-model"])
      await assert.rejects(changeAgentModel(owner.headers, bad), refused(400));
    await assert.rejects(changeAgentModel(owner.headers, unserved), refused(503));
    assert.deepEqual(await rows(), []);
    assert.equal(await currentAgentModel(), AGENT_MODEL);
  });

  await t.test("an admin's accepted model is stored with who and when", async () => {
    await changeAgentModel(owner.headers, accepted);
    const stored = await rows();
    assert.equal(stored.length, 1);
    assert.equal(stored[0].key, "agent_model");
    assert.equal(stored[0].value, accepted);
    assert.equal(stored[0].updated_by, owner.id);
    assert.ok(stored[0].updated_at instanceof Date);
    assert.equal(await currentAgentModel(), accepted);
    assert.deepEqual(await agentModelSetting(), {
      model: accepted,
      updatedBy: `${owner.id}@example.invalid`,
      updatedAt: stored[0].updated_at,
    });
    await changeAgentModel(owner.headers, AGENT_MODEL);
    assert.equal((await rows()).length, 1, "a second change replaces the row");
    assert.equal(await currentAgentModel(), AGENT_MODEL);
  });

  assert.ok(catalogRequests.length >= 1, "the catalog fake was exercised");
});
