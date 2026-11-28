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
  max: 4,
  options: "-c search_path=ctf,public",
});
(globalThis as typeof globalThis & { ctfPool?: Pool }).ctfPool = pool;

const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");
// Setup runs these after Better Auth creates its tables.
const AFTER_AUTH = ["004-rate-limit-timestamp.sql", "033-display-name.sql"];
const origin = "https://flags.integration.test";
const EMAIL = "delivered@resend.dev";

await test("the sign-in link the real stack writes", { timeout: 120_000 }, async (t) => {
  t.after(() => pool.end());
  // Same order as scripts/setup.ts: game migrations, Better Auth, then the ones that adjust its tables.
  const setup = await read("../../scripts/setup.ts");
  const listed = [...setup.matchAll(/"(\d{3}-[\w-]+\.sql)"/g)].map((match) => match[1]);
  await pool.query(await read("../../db/schema.sql"));
  for (const file of listed.filter((file) => !AFTER_AUTH.includes(file)))
    await pool.query(await read(`../../db/migrations/${file}`));
  process.env.BETTER_AUTH_SECRET = "integration-only-secret-long-enough-for-better-auth";
  process.env.BETTER_AUTH_URL = origin;
  process.env.RESEND_API_KEY = "re_integration_only";
  process.env.RESEND_FROM = "Capture the flag <ctf@example.invalid>";
  const { auth } = await import("../../lib/auth");
  const { getMigrations } = await import("better-auth/db/migration");
  await (await getMigrations(auth.options)).runMigrations();
  for (const file of AFTER_AUTH) await pool.query(await read(`../../db/migrations/${file}`));

  // The seam reads its mode and addresses at import.
  process.env.E2E_STACK = "real";
  process.env.E2E_BASE_URL = origin;
  process.env.E2E_DATABASE_URL = connection.toString();
  const { signInLink } = await import("../../tests/e2e/stack");
  // Better Auth's handler needs a host header, which a bare Request does not carry.
  const verify = (link: string) => auth.handler(new Request(link, { headers: { host: "x" } }));

  await t.test("signs the member in and redirects to the destination", async () => {
    const response = await verify(await signInLink(EMAIL, "/account"));
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), `${origin}/account`);
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    assert.match(cookie, /session_token=/);
    const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
    assert.equal(session?.user.email, EMAIL);
  });

  await t.test("refuses an expired row", async () => {
    const link = await signInLink(EMAIL, "/account");
    await pool.query(`UPDATE ctf.verification SET "expiresAt"=now() - interval '1 minute'`);
    const response = await verify(link);
    assert.equal(response.status, 302);
    assert.match(response.headers.get("location") ?? "", /error=INVALID_TOKEN/);
    assert.deepEqual(response.headers.getSetCookie(), []);
  });
});
