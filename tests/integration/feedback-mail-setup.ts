import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { TestContext } from "node:test";
import { Pool } from "pg";
import { createFastmailFake, type Failure } from "./fastmail-fake";

export const TOKEN = "synthetic-fastmail-token";
export const CONTACT = "contact@ctf.example.test";
export const ORIGIN = "https://feedback-mail.integration.test";
export const FAILURES: Failure[] = [
  "session-500",
  "api-500",
  "malformed",
  "method-error",
  "email-not-created",
  "submission-not-created",
  "submission-method-error",
  "submission-missing",
];
// What the client says for each way Fastmail can fail, so a test cannot pass on the wrong error.
export const EXPECTED: Record<Failure, RegExp> = {
  "session-500": /answered 500/,
  "api-500": /answered 500/,
  malformed: /malformed JSON/,
  "method-error": /method error serverFail/,
  "email-not-created": /did not create the email: invalidProperties/,
  "submission-not-created": /did not submit the email: forbiddenToSend/,
  "submission-method-error": /method error serverFail/,
  "submission-missing": /left out a response/,
  hang: /timeout|abort/i,
};

export const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

// A disposable database with every migration, real Better Auth, the real route and the Fastmail
// fake at the fetch boundary. Each test file gets its own database.
export async function setupFeedbackMail(t: TestContext) {
  const base = new URL(process.env.CTF_INTEGRATION_DATABASE_URL ?? "http://missing");
  assert.equal(base.hostname, "127.0.0.1", "Use npm run test:integration");
  assert.match(base.pathname, /^\/ctf_integration_[a-f0-9]{32}$/);
  const database = `ctf_integration_${randomUUID().replaceAll("-", "")}`;
  const adminUrl = new URL(base);
  adminUrl.pathname = "/postgres";
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
  process.env.BETTER_AUTH_URL = ORIGIN;
  process.env.SITE_URL = ORIGIN;
  const { auth } = await import("../../lib/auth");
  const { getMigrations } = await import("better-auth/db/migration");
  await (await getMigrations(auth.options)).runMigrations();
  for (const file of afterAuth) await pool.query(await read(`../../db/migrations/${file}`));

  const fake = createFastmailFake();
  t.mock.method(globalThis, "fetch", fake.fetch);
  const logged: string[] = [];
  t.mock.method(console, "error", (line: unknown) => logged.push(String(line)));
  t.beforeEach(async () => {
    fake.reset();
    logged.length = 0;
    process.env.FASTMAIL_API_TOKEN = TOKEN;
    process.env.CONTACT_EMAIL = CONTACT;
    await pool.query("DELETE FROM ctf.feedback");
  });
  // The fake records what the app did wrong even when the app swallowed the error it caused.
  t.afterEach(() => {
    const violations = fake.violations.splice(0);
    assert.deepEqual(violations, []);
  });

  const { POST } = await import("../../app/api/feedback/route");
  const until = async (done: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 300 && !(await done()); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(await done(), "timed out waiting");
  };
  const signIn = async (member: boolean) => {
    const signedIn = await auth.api.signInAnonymous({ returnHeaders: true });
    const id = signedIn.response!.user.id;
    if (member) await pool.query(`UPDATE ctf."user" SET "isAnonymous"=false WHERE id=$1`, [id]);
    const cookie = signedIn.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const { rows } = await pool.query(`SELECT email FROM ctf."user" WHERE id=$1`, [id]);
    return { id, cookie, email: rows[0].email as string };
  };
  let client = 0;
  const post = async (payload: unknown, cookie?: string) => {
    const response = await POST(
      new Request(`${ORIGIN}/api/feedback`, {
        method: "POST",
        headers: {
          origin: ORIGIN,
          "Content-Type": "application/json",
          "x-forwarded-for": `198.51.100.${++client}`,
          ...(cookie ? { cookie } : {}),
        },
        body: JSON.stringify(payload),
      }),
    );
    return response.status;
  };
  const rows = async () =>
    (await pool.query("SELECT * FROM ctf.feedback ORDER BY created_at")).rows;
  const threadOf = async (id: string) =>
    (await pool.query("SELECT mail_thread_id FROM ctf.feedback WHERE id=$1", [id])).rows[0]
      .mail_thread_id as string | null;
  const contact = { kind: "contact", name: " Ada ", email: "ada@example.com", message: " Hello " };
  const alice = await signIn(true);
  const boss = await signIn(true);
  await pool.query(`UPDATE ctf."user" SET "isAdmin"=true WHERE id=$1`, [boss.id]);
  const guest = await signIn(false);
  const gameId = randomUUID();
  await pool.query(
    `INSERT INTO ctf.games(id,owner_id,sprite_name,secret_hash,agent_model,monitor_model,monitor_version,
      status,token_budget,agent_effort,system_prompt,monitor_mode,submission_transport)
     VALUES($1,$2,$3,$4,'agent','monitor','version','active',1000,'medium','','async','http')`,
    [gameId, alice.id, `sprite-${gameId}`, "hash"],
  );
  await pool.query(
    `INSERT INTO ctf.agent_sessions(id,game_id,ordinal,agent_model,agent_effort,system_prompt)
     VALUES($1,$1,1,'agent','medium','')`,
    [gameId],
  );
  const insertRow = async ({
    email = "ada@example.com",
    thread = null,
    closed = false,
    age = 0,
  }: { email?: string; thread?: string | null; closed?: boolean; age?: number } = {}) =>
    (
      await pool.query(
        `INSERT INTO ctf.feedback(kind,name,email,message,sender,mail_thread_id,closed_at,created_at)
         VALUES('contact','Ada',$1,'Hello','ip:test',$2,CASE WHEN $3 THEN now() END,
           now()-make_interval(mins => $4)) RETURNING id`,
        [email, thread, closed, age],
      )
    ).rows[0].id as string;
  // A stored message whose notification went out through the real route.
  const notified = async () => {
    assert.equal(await post(contact), 200);
    const row = (await rows()).at(-1);
    await until(async () => (await threadOf(row.id)) !== null);
    return { id: row.id as string, thread: (await threadOf(row.id))! };
  };
  const lastSent = () => fake.submissions.at(-1)!.email;
  return {
    pool,
    fake,
    logged,
    listed,
    post,
    rows,
    threadOf,
    until,
    contact,
    alice,
    guest,
    gameId,
    insertRow,
    notified,
    lastSent,
    bossHeaders: new Headers({ cookie: boss.cookie }),
    aliceHeaders: new Headers({ cookie: alice.cookie }),
    guestHeaders: new Headers({ cookie: guest.cookie }),
  };
}
