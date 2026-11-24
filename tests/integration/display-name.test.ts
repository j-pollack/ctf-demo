import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Pool } from "pg";
import { createAccountFake } from "./display-name-fake";

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
  max: 8,
  options: "-c search_path=ctf,public",
});
(globalThis as typeof globalThis & { ctfPool?: Pool }).ctfPool = pool;

const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");
const MIGRATION_033 = "033-display-name.sql";
const origin = "http://localhost";
const events = (lines: string[], event: string) =>
  lines.flatMap((line) => {
    try {
      const parsed = JSON.parse(line);
      return parsed.event === event ? [parsed] : [];
    } catch {
      return [];
    }
  });
const cookieOf = (response: Response | Headers) =>
  (response instanceof Headers ? response : response.headers)
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");

await test("display names and account changes", { timeout: 120_000 }, async (t) => {
  t.after(() => pool.end());
  // Same order as scripts/setup.ts: game migrations, Better Auth, then the ones that adjust its tables.
  const setup = await read("../../scripts/setup.ts");
  const listed = [...setup.matchAll(/"(\d{3}-[\w-]+\.sql)"/g)].map((match) => match[1]);
  await pool.query(await read("../../db/schema.sql"));
  for (const file of listed.filter(
    (file) => !["004-rate-limit-timestamp.sql", MIGRATION_033].includes(file),
  ))
    await pool.query(await read(`../../db/migrations/${file}`));
  process.env.BETTER_AUTH_SECRET = "integration-only-secret-long-enough-for-better-auth";
  process.env.BETTER_AUTH_URL = origin;
  process.env.RESEND_API_KEY = "re_integration_only";
  process.env.RESEND_FROM = "Capture the flag <ctf@example.invalid>";
  const { auth } = await import("../../lib/auth");
  const { getMigrations } = await import("better-auth/db/migration");
  await (await getMigrations(auth.options)).runMigrations();
  await pool.query(await read("../../db/migrations/004-rate-limit-timestamp.sql"));

  await t.test("M1: migration 033 applies twice and setup and runbook name it", async () => {
    const sql = await read(`../../db/migrations/${MIGRATION_033}`);
    await pool.query(sql);
    await pool.query(sql);
    assert.ok(listed.includes(MIGRATION_033), "setup lists 033");
    assert.ok(
      setup.indexOf(MIGRATION_033) > setup.indexOf("runMigrations()"),
      "033 runs after Better Auth creates the user table",
    );
    assert.match(await read("../../deploy/operations.md"), /033-display-name/);
    const { rows: indexes } = await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE schemaname='ctf' AND indexname='user_display_name_unique'`,
    );
    assert.match(indexes[0].indexdef, /UNIQUE INDEX .* \(lower\("displayName"\)\) WHERE/);
    const { rows: columns } = await pool.query(
      `SELECT column_name,is_nullable FROM information_schema.columns
       WHERE table_schema='ctf' AND table_name='inference' AND column_name IN ('game_id','user_id')
       ORDER BY column_name`,
    );
    assert.deepEqual(columns, [
      { column_name: "game_id", is_nullable: "YES" },
      { column_name: "user_id", is_nullable: "YES" },
    ]);
    const { rows: owner } = await pool.query(
      `SELECT convalidated FROM pg_constraint WHERE conname='inference_owner_check'`,
    );
    assert.deepEqual(owner, [{ convalidated: true }], "added NOT VALID, then validated");
    assert.match(sql, /ADD CONSTRAINT inference_owner_check\s+CHECK \([^;]*\) NOT VALID;/);
    assert.match(sql, /^ALTER TABLE ctf\.inference VALIDATE CONSTRAINT inference_owner_check;$/m);
    await pool.query(
      "INSERT INTO ctf.daily_spend(day) VALUES((now() AT TIME ZONE 'UTC')::date) ON CONFLICT DO NOTHING",
    );
    for (const [role, user] of [
      ["agent", "someone"],
      ["account", null],
    ])
      await assert.rejects(
        pool.query(
          `INSERT INTO ctf.inference(id,game_id,user_id,day,role,model,token_ceiling,cost_ceiling)
           VALUES(gen_random_uuid(),NULL,$2,(now() AT TIME ZONE 'UTC')::date,$1,'m',1,1)`,
          [role, user],
        ),
        /inference_owner_check/,
        `${role} without a game`,
      );
  });

  const fake = createAccountFake();
  t.mock.method(globalThis, "fetch", fake.fetch);
  t.beforeEach(() => fake.reset());

  // Better Auth limits sign-in requests per client address, so each synthetic player has its own.
  let client = 0;
  const signUp = async (email: string, extra: Record<string, unknown> = {}) => {
    const sent = await auth.handler(
      new Request(`${origin}/api/auth/sign-in/magic-link`, {
        method: "POST",
        headers: {
          origin,
          "Content-Type": "application/json",
          "x-forwarded-for": `198.51.100.${++client}`,
        },
        body: JSON.stringify({ email, callbackURL: "/play", ...extra }),
      }),
    );
    assert.equal(sent.status, 200);
    const verified = await auth.handler(
      new Request(fake.mail.at(-1)!.link, {
        headers: { "x-forwarded-for": `198.51.100.${client}` },
      }),
    );
    assert.equal(verified.status, 302);
    const cookie = cookieOf(verified);
    const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
    assert.ok(session);
    return { cookie, id: session.user.id };
  };
  const { POST: saveRoute } = await import("../../app/api/account/display-name/route");
  const save = async (
    cookie: string | null,
    payload: unknown,
    headers: Record<string, string> = { origin },
  ) => {
    const response = await saveRoute(
      new Request(`${origin}/api/account/display-name`, {
        method: "POST",
        headers: { ...headers, ...(cookie ? { cookie } : {}), "Content-Type": "application/json" },
        body: typeof payload === "string" ? payload : JSON.stringify(payload),
      }),
    );
    return { status: response.status, body: await response.json() };
  };
  const storedName = async (id: string) =>
    (await pool.query(`SELECT "displayName" FROM ctf."user" WHERE id=$1`, [id])).rows[0]
      .displayName as string | null;
  const accountRows = async (id: string) =>
    (
      await pool.query(
        `SELECT game_id,role,model,tokens,cost,token_ceiling,cost_ceiling,settled_at IS NOT NULL AS settled
         FROM ctf.inference WHERE user_id=$1 ORDER BY created_at`,
        [id],
      )
    ).rows;
  const today = async () =>
    (
      await pool.query(
        "SELECT charged::bigint AS charged,reserved::bigint AS reserved FROM ctf.daily_spend WHERE day=(now() AT TIME ZONE 'UTC')::date",
      )
    ).rows[0] ?? { charged: "0", reserved: "0" };

  const newcomer = await signUp("newcomer@example.invalid");

  await t.test(
    "I1: a new account has no name and cannot start a run until it sets one",
    async () => {
      assert.equal(await storedName(newcomer.id), null);
      const { POST: start } = await import("../../app/api/games/route");
      const before = (await pool.query("SELECT count(*)::int AS n FROM ctf.games")).rows[0].n;
      const refused = await start(
        new Request(`${origin}/api/games`, {
          method: "POST",
          headers: { origin, cookie: newcomer.cookie, "Content-Type": "application/json" },
          body: "{}",
        }),
      );
      assert.equal(refused.status, 403);
      assert.equal(
        (await refused.json()).error,
        "Choose a display name on your account page before you start a run.",
      );
      assert.equal(
        (await pool.query("SELECT count(*)::int AS n FROM ctf.games")).rows[0].n,
        before,
      );
      assert.deepEqual(fake.names, [], "the gate asks nothing of Jev");
    },
  );

  await t.test(
    "I3: an accepted name is stored and its check is billed to the account",
    async (s) => {
      const logs: string[] = [];
      s.mock.method(console, "info", (line: string) => logs.push(String(line)));
      const spend = await today();
      const games = (
        await pool.query("SELECT coalesce(sum(spent_microdollars),0)::bigint AS s FROM ctf.games")
      ).rows[0].s;
      const saved = await save(newcomer.cookie, { displayName: "  Night_Owl-7 " });
      assert.deepEqual(saved, { status: 200, body: { displayName: "Night_Owl-7" } });
      assert.deepEqual(fake.names, ["Night_Owl-7"], "Jev sees the trimmed name");
      assert.deepEqual(events(logs, "display_name.checked"), [
        {
          event: "display_name.checked",
          questionSet: "display-name-v1",
          userId: newcomer.id,
          name: "Night_Owl-7",
          scores: { offensive: 0.05, sexual: 0.05, impersonates: 0.05 },
          threshold: 0.6,
          outcome: "allowed",
        },
      ]);
      assert.equal(await storedName(newcomer.id), "Night_Owl-7");
      const session = await auth.api.getSession({
        headers: new Headers({ cookie: newcomer.cookie }),
      });
      assert.equal(session?.user.displayName, "Night_Owl-7");
      const { TYPESAFE_MODEL } = await import("../../lib/typesafe");
      const rows = await accountRows(newcomer.id);
      assert.equal(rows.length, 1);
      assert.deepEqual(
        { ...rows[0], token_ceiling: undefined, cost_ceiling: undefined },
        {
          game_id: null,
          role: "account",
          model: TYPESAFE_MODEL,
          tokens: 900,
          cost: String(Math.round(900 * 0.042)),
          settled: true,
          token_ceiling: undefined,
          cost_ceiling: undefined,
        },
      );
      assert.ok(Number(rows[0].token_ceiling) >= 900, "the reservation covered the reported usage");
      const after = await today();
      assert.equal(Number(after.charged) - Number(spend.charged), 38);
      assert.equal(after.reserved, spend.reserved, "the hold is released");
      assert.equal(
        (await pool.query("SELECT coalesce(sum(spent_microdollars),0)::bigint AS s FROM ctf.games"))
          .rows[0].s,
        games,
        "no run pays for a name check",
      );
      assert.deepEqual(await save(newcomer.cookie, { displayName: "Night_Owl-7" }), {
        status: 200,
        body: { displayName: "Night_Owl-7" },
      });
      assert.equal(fake.names.length, 1, "saving the same name again asks nothing");
    },
  );

  await t.test("I2: Better Auth's own endpoints cannot set a display name", async () => {
    const update = await auth.handler(
      new Request(`${origin}/api/auth/update-user`, {
        method: "POST",
        headers: { origin, cookie: newcomer.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "bypass_name" }),
      }),
    );
    assert.equal(update.status, 400);
    assert.match(await update.text(), /displayName is not allowed to be set/);
    assert.equal(await storedName(newcomer.id), "Night_Owl-7");
    const viaLink = await signUp("linkname@example.invalid", { name: "bypass_name" });
    assert.equal(
      await storedName(viaLink.id),
      null,
      "a name sent with the link is not a display name",
    );
  });

  const second = await signUp("second@example.invalid");

  await t.test("I4: a name Jev refuses is not stored and its check is still billed", async (s) => {
    const logs: string[] = [];
    s.mock.method(console, "info", (line: string) => logs.push(String(line)));
    fake.controls.scores = (value): Record<string, number> =>
      value === "rude_name" ? { offensive: 0.82 } : {};
    const refused = await save(second.cookie, { displayName: "rude_name" });
    assert.deepEqual(refused, {
      status: 422,
      body: { error: "That name can't be used on the leaderboard. Try another." },
    });
    assert.equal(await storedName(second.id), null);
    assert.deepEqual(
      events(logs, "display_name.checked").map(({ name, scores, outcome }) => ({
        name,
        scores,
        outcome,
      })),
      [
        {
          name: "rude_name",
          scores: { offensive: 0.82, sexual: 0.05, impersonates: 0.05 },
          outcome: "refused",
        },
      ],
    );
    const rows = await accountRows(second.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].settled, true);
    assert.equal(rows[0].tokens, 900);
  });

  await t.test("I5: an unavailable Jev or a full daily budget refuses to save", async () => {
    const retry = { error: "We couldn't check that name right now. Try again." };
    for (const behaviour of [500, 429, "malformed", "hang"] as const) {
      fake.reset();
      fake.controls.behave = () => behaviour;
      const before = (await accountRows(second.id)).length;
      const started = performance.now();
      assert.deepEqual(
        await save(second.cookie, { displayName: "steady_name" }),
        {
          status: 503,
          body: retry,
        },
        String(behaviour),
      );
      if (behaviour === "hang") {
        const { NAME_CHECK_DEADLINE_MS } = await import("../../lib/display-name-check");
        assert.ok(
          performance.now() - started >= NAME_CHECK_DEADLINE_MS - 50,
          "waited for the deadline",
        );
      }
      assert.equal(await storedName(second.id), null, String(behaviour));
      const rows = await accountRows(second.id);
      assert.equal(rows.length, before + 1, String(behaviour));
      const last = rows.at(-1);
      assert.equal(last.settled, true, `${behaviour}: the hold is settled`);
      assert.equal(
        last.tokens,
        last.token_ceiling,
        `${behaviour}: a check without usable usage is charged at its ceiling`,
      );
    }
    fake.reset();
    const { DAILY_CAP_MICRODOLLARS } = await import("../../lib/policy");
    const day = await pool.query(
      "UPDATE ctf.daily_spend SET charged=charged+$1 WHERE day=(now() AT TIME ZONE 'UTC')::date RETURNING charged",
      [DAILY_CAP_MICRODOLLARS],
    );
    try {
      const before = (await accountRows(second.id)).length;
      assert.deepEqual(await save(second.cookie, { displayName: "steady_name" }), {
        status: 503,
        body: { error: "Name checks are paused until tomorrow (UTC). Try again then." },
      });
      assert.deepEqual(fake.names, [], "nothing is sent past the cap");
      assert.equal((await accountRows(second.id)).length, before, "and nothing is reserved");
    } finally {
      await pool.query(
        "UPDATE ctf.daily_spend SET charged=charged-$1 WHERE day=(now() AT TIME ZONE 'UTC')::date",
        [DAILY_CAP_MICRODOLLARS],
      );
    }
    assert.ok(day.rowCount);
    assert.equal(await storedName(second.id), null);
  });

  await t.test("I6: names are unique ignoring case, and a race has one winner", async () => {
    const taken = await save(second.cookie, { displayName: "NIGHT_OWL-7" });
    assert.deepEqual(taken, { status: 409, body: { error: "That name is taken." } });
    assert.deepEqual(fake.names, [], "a taken name is refused before Jev is asked");
    // A change of case alone shows differently on the board, so Jev checks it again.
    assert.deepEqual(await save(newcomer.cookie, { displayName: "night_owl-7" }), {
      status: 200,
      body: { displayName: "night_owl-7" },
    });
    assert.deepEqual(fake.names, ["night_owl-7"]);
    assert.equal(await storedName(newcomer.id), "night_owl-7");
    assert.equal((await save(newcomer.cookie, { displayName: "Night_Owl-7" })).status, 200);
    fake.reset();
    const [left, right] = [
      await signUp("left@example.invalid"),
      await signUp("right@example.invalid"),
    ];
    let release!: () => void;
    const both = new Promise<void>((resolve) => (release = resolve));
    fake.controls.hold = async (index) => {
      if (index === 1) release();
      await both;
    };
    const results = await Promise.all([
      save(left.cookie, { displayName: "Contested" }),
      save(right.cookie, { displayName: "contested" }),
    ]);
    assert.equal(fake.names.length, 2, "both passed the early check and reached Jev");
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
    assert.deepEqual(results.find((result) => result.status === 409)?.body, {
      error: "That name is taken.",
    });
    const holders = (
      await pool.query(`SELECT id FROM ctf."user" WHERE lower("displayName")='contested'`)
    ).rows;
    assert.equal(holders.length, 1, "exactly one account holds the name");
  });

  await t.test(
    "I7: the per-account daily limit refuses the 21st check without asking Jev",
    async () => {
      const busy = await signUp("busy@example.invalid");
      const { NAME_CHECKS_PER_DAY } = await import("../../lib/display-name-check");
      assert.equal(NAME_CHECKS_PER_DAY, 20);
      for (let index = 0; index < NAME_CHECKS_PER_DAY; index++)
        assert.equal((await save(busy.cookie, { displayName: `busy_${index}` })).status, 200);
      assert.equal(fake.names.length, NAME_CHECKS_PER_DAY);
      assert.deepEqual(await save(busy.cookie, { displayName: "busy_last" }), {
        status: 429,
        body: { error: "You've checked too many names today. Try again tomorrow." },
      });
      assert.equal(fake.names.length, NAME_CHECKS_PER_DAY);
      assert.equal(await storedName(busy.id), `busy_${NAME_CHECKS_PER_DAY - 1}`);
    },
  );

  await t.test("I8: only a signed-in member can change a name, and only their own", async () => {
    assert.equal((await save(null, { displayName: "anon_name" })).status, 401);
    const guest = await auth.api.signInAnonymous({ returnHeaders: true });
    assert.equal((await save(cookieOf(guest.headers), { displayName: "guest_name" })).status, 401);
    assert.deepEqual(
      await save(second.cookie, { displayName: "far_away" }, { origin: "https://evil.example" }),
      { status: 403, body: { error: "Request origin is not allowed." } },
    );
    assert.equal((await save(second.cookie, "not json")).status, 400);
    assert.deepEqual(await save(second.cookie, { displayName: "bad name" }), {
      status: 400,
      body: { error: "Use 3 to 24 letters, digits, hyphens or underscores, with no spaces." },
    });
    assert.deepEqual(fake.names, [], "refused requests reach no one");
    const saved = await save(second.cookie, {
      displayName: "Second_Self",
      userId: newcomer.id,
      id: newcomer.id,
    });
    assert.equal(saved.status, 200);
    assert.equal(await storedName(second.id), "Second_Self");
    assert.equal(await storedName(newcomer.id), "Night_Owl-7", "another account is untouched");
  });

  await t.test("I9: an email change needs a verified inbox, then the new one", async (s) => {
    const logs: string[] = [];
    s.mock.method(console, "error", (line: unknown) => logs.push(String(line)));
    const info: string[] = [];
    s.mock.method(console, "info", (line: unknown) => info.push(String(line)));
    let address = 0;
    const change = (cookie: string, newEmail: string, ip = `203.0.113.${++address}`) =>
      auth.handler(
        new Request(`${origin}/api/auth/change-email`, {
          method: "POST",
          headers: { origin, cookie, "Content-Type": "application/json", "x-forwarded-for": ip },
          body: JSON.stringify({ newEmail, callbackURL: "/account" }),
        }),
      );
    const settle = () => new Promise((resolve) => setTimeout(resolve, 100));
    const email = async (id: string) =>
      (await pool.query(`SELECT email FROM ctf."user" WHERE id=$1`, [id])).rows[0].email;

    // Guests and unverified accounts would skip the current-inbox step, so they are refused.
    const refusal = "Only a verified email can be changed. Sign in with an email link first.";
    const guest = await auth.api.signInAnonymous({ returnHeaders: true });
    const unverified = await signUp("unverified@example.invalid");
    await pool.query(`UPDATE ctf."user" SET "emailVerified"=false WHERE id=$1`, [unverified.id]);
    fake.reset();
    for (const cookie of [cookieOf(guest.headers), unverified.cookie]) {
      const refused = await change(cookie, "elsewhere@example.invalid");
      assert.equal(refused.status, 403);
      assert.equal((await refused.json()).message, refusal);
    }
    await settle();
    assert.deepEqual(fake.mail, [], "a refused change sends nothing");
    assert.equal(await email(unverified.id), "unverified@example.invalid");

    // The send runs after the response: the response arrives while Resend is still held.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    fake.controls.mailHold = () => held;
    const requested = await change(second.cookie, "Moved+tag@Example.invalid");
    assert.equal(requested.status, 200);
    const answer = await requested.text();
    const [confirmation] = await fake.waitForMail(1);
    assert.deepEqual(
      { to: confirmation.to, subject: confirmation.subject },
      { to: "second@example.invalid", subject: "Confirm your Capture the flag email change" },
    );
    release();
    assert.equal(await email(second.id), "second@example.invalid", "nothing changes yet");
    const confirmed = await auth.handler(
      new Request(confirmation.link, { headers: { cookie: second.cookie } }),
    );
    assert.equal(confirmed.status, 302);
    assert.equal(confirmed.headers.get("location"), "/account?email=confirmed");
    assert.equal(await email(second.id), "second@example.invalid", "nor before the new inbox");
    const verification = (await fake.waitForMail(2))[1];
    assert.deepEqual(
      { to: verification.to, subject: verification.subject },
      { to: "moved@example.invalid", subject: "Verify your new Capture the flag email" },
      "the new address is canonicalized like a sign-in address",
    );
    const verified = await auth.handler(
      new Request(verification.link, { headers: { cookie: second.cookie } }),
    );
    assert.equal(verified.status, 302);
    assert.equal(verified.headers.get("location"), "/account?email=changed");
    assert.equal(await email(second.id), "moved@example.invalid");
    assert.equal(await storedName(second.id), "Second_Self", "the name stays with the account");

    fake.reset();
    const resend = await auth.handler(
      new Request(`${origin}/api/auth/send-verification-email`, {
        method: "POST",
        headers: { origin, cookie: second.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ email: "moved@example.invalid" }),
      }),
    );
    assert.equal(resend.status, 404, "the change flow's sender is not a public endpoint");

    // A taken address and a failed send both answer exactly like a sent link.
    const collision = await change(newcomer.cookie, "moved@example.invalid");
    assert.equal(collision.status, requested.status);
    assert.equal(await collision.text(), answer, "a taken address looks the same");
    await settle();
    assert.deepEqual(fake.mail, [], "and sends nothing");
    // Only the server log tells a taken address from a new one, and a sent email from none.
    assert.deepEqual(
      events(info, "auth.change_email.requested").map((event) => event.newAddressTaken),
      [false, true],
    );
    assert.deepEqual(
      events(info, "auth.email.sent")
        .filter((event) => event.purpose === "confirmation")
        .map((event) => event.subject),
      ["Confirm your Capture the flag email change", "Verify your new Capture the flag email"],
    );
    fake.controls.mailStatus = 500;
    const failed = await change(newcomer.cookie, "elsewhere@example.invalid");
    assert.equal(failed.status, requested.status);
    assert.equal(await failed.text(), answer, "a failed send looks the same");
    await fake.waitForMail(1);
    await settle();
    assert.equal(events(logs, "auth.email.failed").length, 1, "the failure is logged");
    assert.equal(await email(newcomer.id), "newcomer@example.invalid");

    // Three requests per address in ten minutes.
    fake.reset();
    const limited = [];
    for (let i = 0; i < 4; i++)
      limited.push(
        (await change(newcomer.cookie, `rate${i}@example.invalid`, "198.18.0.9")).status,
      );
    assert.deepEqual(limited, [200, 200, 200, 429]);
    await fake.waitForMail(3);
  });

  await t.test("I10: the leaderboard shows display names and never an email", async () => {
    const { currentGameRules } = await import("../../lib/game-rules");
    const { ASYNC_MONITOR_VERSION } = await import("../../lib/control");
    const rules = await currentGameRules();
    const legacy = await signUp("legacy@example.invalid");
    const capture = async (owner: string, spent: number) => {
      const id = randomUUID();
      await pool.query(
        `INSERT INTO ctf.games(id,owner_id,sprite_name,secret_hash,agent_model,monitor_model,monitor_version,
           monitor_difficulty,status,token_budget,monitor_isolation,bug_fix_required,jailbreak_catch)
         VALUES($1::uuid,$2,$1::text,'h','agent/a','mon/a',$3,'hard','captured',1000,$4,$5,$6)`,
        [
          id,
          owner,
          ASYNC_MONITOR_VERSION,
          rules.monitorIsolation,
          rules.bugFixRequired,
          rules.jailbreakCatch,
        ],
      );
      await pool.query(
        `INSERT INTO ctf.inference(id,game_id,day,role,model,token_ceiling,cost_ceiling,tokens,cost,settled_at)
         VALUES(gen_random_uuid(),$1,(now() AT TIME ZONE 'UTC')::date,'agent','agent/a',1,$2,1,$2,now())`,
        [id, spent],
      );
    };
    await capture(newcomer.id, 100);
    await capture(legacy.id, 200);
    const { GET } = await import("../../app/api/leaderboard/route");
    const response = await GET(new Request(`${origin}/api/leaderboard`));
    const text = await response.text();
    const { createHash } = await import("node:crypto");
    assert.deepEqual(
      JSON.parse(text).entries.map((entry: { name: string }) => entry.name),
      ["Night_Owl-7", `Player ${createHash("sha256").update(legacy.id).digest("hex").slice(0, 6)}`],
    );
    assert.doesNotMatch(text, /@|example\.invalid/, "no email reaches the board");
  });
});
