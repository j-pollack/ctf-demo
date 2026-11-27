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

await test("admin-set limits are read with defaults, validated, authorised and stored", async (t) => {
  t.after(() => pool.end());
  const sql = (file: string) => readFile(new URL(`../../db/${file}`, import.meta.url), "utf8");
  await pool.query(await sql("schema.sql"));
  await pool.query(await sql("migrations/017-settings.sql"));

  process.env.BETTER_AUTH_SECRET = "integration-only-secret-long-enough-for-better-auth";
  process.env.BETTER_AUTH_URL = "http://localhost";
  const { auth } = await import("../../lib/auth");
  await (
    await (await import("better-auth/db/migration")).getMigrations(auth.options)
  ).runMigrations();
  const { GameError } = await import("../../lib/policy");
  const { DEFAULT_LIMITS, LIMIT_KEYS, currentLimits } = await import("../../lib/limits");
  const { changeLimit, limitSettings } = await import("../../lib/limits-admin");

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
  const restoreEnv = (saved: Record<string, string | undefined>) => {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  };
  const rows = async () => (await pool.query("SELECT * FROM ctf.settings ORDER BY key")).rows;
  const refused = (status: number) => (error: unknown) =>
    error instanceof GameError && error.status === status;

  await t.test("L1 with no rows and no environment the thirteen defaults hold", async () => {
    assert.equal(LIMIT_KEYS.length, 13);
    assert.deepEqual(await currentLimits(), DEFAULT_LIMITS);
    assert.deepEqual(await limitSettings(), {});
  });

  await t.test("L2 a bad stored value falls back for that key only", async () => {
    await pool.query(
      `INSERT INTO ctf.settings(key,value) VALUES
       ('daily_cap_microdollars','12000000'),('run_budget_microdollars','1.5'),
       ('runs_per_day','0'),('total_runs_per_day','07'),
       ('monitor_run_allowance_microdollars','99'),('final_review_allowance_microdollars','2000000')`,
    );
    assert.deepEqual(await currentLimits(), {
      ...DEFAULT_LIMITS,
      dailyCapMicrodollars: 12_000_000,
      finalReviewAllowanceMicrodollars: 2_000_000,
    });
    const client = await pool.connect();
    try {
      assert.deepEqual(await currentLimits(client), await currentLimits());
    } finally {
      client.release();
    }
    await pool.query("DELETE FROM ctf.settings");
  });

  await t.test(
    "L3 anyone who is not a signed-in admin is refused and nothing changes",
    async () => {
      const guest = await signIn({});
      const adminGuest = await signIn({ admin: true });
      const member = await signIn({ member: true });
      for (const who of [new Headers(), guest.headers, adminGuest.headers, member.headers])
        await assert.rejects(changeLimit(who, "runs_per_day", "5"), refused(404));
      assert.deepEqual(await rows(), []);
      assert.deepEqual(await currentLimits(), DEFAULT_LIMITS);
    },
  );

  const owner = await signIn({ member: true, admin: true });
  await t.test("L4 an admin's invalid value is refused and nothing changes", async () => {
    const bad: Array<[unknown, unknown]> = [
      ["nope", "5"],
      [undefined, "5"],
      [7, "5"],
      ["runs_per_day", undefined],
      ["runs_per_day", 5],
      ["runs_per_day", null],
      ["runs_per_day", ""],
      ["runs_per_day", "-1"],
      ["runs_per_day", "2.5"],
      ["runs_per_day", "0"],
      ["runs_per_day", "51"],
      ["total_runs_per_day", "10001"],
      ["daily_cap_microdollars", "101"],
      ["daily_cap_microdollars", "1.234"],
      ["daily_cap_microdollars", ".5"],
      ["daily_cap_microdollars", "10."],
      ["daily_cap_microdollars", "1e1"],
      ["daily_cap_microdollars", "-1"],
      ["run_budget_microdollars", "0.00"],
      ["run_budget_microdollars", "5.01"],
      ["monitor_run_allowance_microdollars", "0"],
      ["final_review_allowance_microdollars", "10.01"],
    ];
    for (const [key, value] of bad)
      await assert.rejects(changeLimit(owner.headers, key, value), refused(400), `${key} ${value}`);
    assert.deepEqual(await rows(), []);
    assert.deepEqual(await currentLimits(), DEFAULT_LIMITS);
  });

  await t.test("L4 an accepted value is stored in microdollars or as a count", async () => {
    for (const value of ["10", "0.5", "0.50"]) {
      await changeLimit(owner.headers, "daily_cap_microdollars", value);
      assert.equal(
        (await currentLimits()).dailyCapMicrodollars,
        Math.round(Number(value) * 1_000_000),
      );
    }
    await changeLimit(owner.headers, "daily_cap_microdollars", "2.01");
    await changeLimit(owner.headers, "runs_per_day", "7");
    await changeLimit(owner.headers, "total_runs_per_day", "0");
    await changeLimit(owner.headers, "run_budget_microdollars", "0.01");
    await changeLimit(owner.headers, "final_review_allowance_microdollars", "0");
    await changeLimit(owner.headers, "monitor_run_allowance_microdollars", "10");
    const stored = Object.fromEntries((await rows()).map((row) => [row.key, row]));
    assert.equal(stored.daily_cap_microdollars.value, "2010000");
    assert.equal(stored.runs_per_day.value, "7");
    assert.equal(stored.total_runs_per_day.value, "0");
    assert.equal(stored.run_budget_microdollars.value, "10000");
    assert.equal(stored.final_review_allowance_microdollars.value, "0");
    assert.equal(stored.monitor_run_allowance_microdollars.value, "10000000");
    for (const row of await rows()) {
      assert.equal(row.updated_by, owner.id);
      assert.ok(row.updated_at instanceof Date);
    }
    assert.equal((await rows()).length, 6, "a repeated change replaces the row");
    assert.deepEqual(await currentLimits(), {
      ...DEFAULT_LIMITS,
      dailyCapMicrodollars: 2_010_000,
      runBudgetMicrodollars: 10_000,
      runsPerDay: 7,
      totalRunsPerDay: 0,
      monitorRunAllowanceMicrodollars: 10_000_000,
      finalReviewAllowanceMicrodollars: 0,
    });
    const settings = await limitSettings();
    assert.deepEqual(
      Object.keys(settings).sort(),
      Object.keys(stored).sort(),
      "only the limits that were changed report who and when",
    );
    assert.equal(settings.runs_per_day?.updatedBy, `${owner.id}@example.invalid`);
    assert.deepEqual(settings.runs_per_day?.updatedAt, stored.runs_per_day.updated_at);
  });

  await t.test("L4 the response time limit takes 5 and 230 and refuses 4 and 231", async () => {
    await pool.query("DELETE FROM ctf.settings");
    for (const bad of ["4", "231"]) {
      await assert.rejects(changeLimit(owner.headers, "response_seconds", bad), refused(400), bad);
      assert.deepEqual(await rows(), []);
    }
    for (const value of ["5", "230"]) {
      await changeLimit(owner.headers, "response_seconds", value);
      assert.equal((await currentLimits()).responseSeconds, Number(value));
      const stored = (await rows()).filter((row) => row.key === "response_seconds");
      assert.deepEqual(
        stored.map((row) => [row.value, row.updated_by]),
        [[value, owner.id]],
      );
    }
    await pool.query("DELETE FROM ctf.settings");
  });

  await t.test(
    "M2 a stored value wins over the environment, which wins over the default",
    async () => {
      await pool.query("DELETE FROM ctf.settings");
      const names = ["CTF_RUNS_PER_DAY", "CTF_AGENT_EFFORT", "CTF_NAME_CHECKS_PER_DAY"];
      const before = Object.fromEntries(names.map((name) => [name, process.env[name]]));
      process.env.CTF_RUNS_PER_DAY = "5";
      process.env.CTF_AGENT_EFFORT = "high";
      process.env.CTF_NAME_CHECKS_PER_DAY = "abc";
      try {
        const fromEnv = await currentLimits();
        assert.equal(fromEnv.runsPerDay, 5, "no row: the environment");
        assert.equal(fromEnv.agentEffort, "high");
        assert.equal(fromEnv.nameChecksPerDay, DEFAULT_LIMITS.nameChecksPerDay, "invalid: default");
        await pool.query(
          `INSERT INTO ctf.settings(key,value) VALUES('runs_per_day','7'),('agent_effort','medium')`,
        );
        const stored = await currentLimits();
        assert.equal(stored.runsPerDay, 7, "a stored value wins");
        assert.equal(stored.agentEffort, "medium");
        await pool.query(
          `UPDATE ctf.settings SET value='0' WHERE key='runs_per_day';
         UPDATE ctf.settings SET value='max' WHERE key='agent_effort'`,
        );
        const invalid = await currentLimits();
        assert.equal(invalid.runsPerDay, 5, "an invalid stored value falls to the environment");
        assert.equal(invalid.agentEffort, "high");
        delete process.env.CTF_RUNS_PER_DAY;
        assert.equal((await currentLimits()).runsPerDay, DEFAULT_LIMITS.runsPerDay);
      } finally {
        restoreEnv(before);
        await pool.query("DELETE FROM ctf.settings");
      }
    },
  );

  await t.test("M10 a choice is stored only when it is one of the options", async () => {
    for (const bad of ["max", "", "Low", "toString", 1, undefined, null])
      await assert.rejects(changeLimit(owner.headers, "agent_effort", bad), refused(400));
    await assert.rejects(
      changeLimit(owner.headers, "investigator_effort", "extreme"),
      refused(400),
    );
    assert.deepEqual(await rows(), []);
    await changeLimit(owner.headers, "investigator_effort", "low");
    await changeLimit(owner.headers, "agent_effort", "medium");
    await changeLimit(owner.headers, "sessions_per_run", "12");
    const limits = await currentLimits();
    assert.equal(limits.investigatorEffort, "low");
    assert.equal(limits.agentEffort, "medium");
    assert.equal(limits.sessionsPerRun, 12);
    assert.equal((await rows()).length, 3);
    assert.deepEqual((await rows()).map((row) => row.value).sort(), ["12", "low", "medium"]);
    await pool.query("DELETE FROM ctf.settings");
  });

  const PLAYER_KEYS = [
    "autoContinueTurns",
    "dailyCapMicrodollars",
    "runBudgetMicrodollars",
    "runsPerDay",
    "sessionsPerRun",
  ];
  const { default: Home } = await import("../../app/page");
  const { default: GameLayout } = await import("../../app/(game)/layout");
  const propsOf = (element: unknown) => (element as { props: Record<string, unknown> }).props;
  const gameUiProps = async () => {
    const layout = await GameLayout({ children: null });
    return propsOf((propsOf(layout).children as unknown[])[0]);
  };

  await t.test("M11 the browser receives exactly the five player limits", async () => {
    await pool.query("INSERT INTO ctf.settings(key,value) VALUES('total_runs_per_day','5')");
    try {
      for (const props of [propsOf(await Home()), await gameUiProps()])
        assert.deepEqual(Object.keys(props.limits as object).sort(), PLAYER_KEYS);
    } finally {
      await pool.query("DELETE FROM ctf.settings");
    }
  });

  await t.test(
    "M3 the two pages render from the environment when settings cannot be read",
    async (s) => {
      const logged: string[] = [];
      s.mock.method(console, "error", (line: unknown) => logged.push(String(line)));
      const before = {
        CTF_RUN_BUDGET_MICRODOLLARS: process.env.CTF_RUN_BUDGET_MICRODOLLARS,
        CTF_AUTO_CONTINUE_TURNS: process.env.CTF_AUTO_CONTINUE_TURNS,
      };
      process.env.CTF_RUN_BUDGET_MICRODOLLARS = "750000";
      process.env.CTF_AUTO_CONTINUE_TURNS = "5";
      await pool.query("ALTER TABLE ctf.settings RENAME TO settings_away");
      try {
        await assert.rejects(currentLimits());
        const { currentGameRules, DEFAULT_GAME_RULES } = await import("../../lib/game-rules");
        await assert.rejects(currentGameRules());
        const landing = propsOf(await Home());
        const layout = await gameUiProps();
        for (const props of [landing, layout]) {
          assert.equal(
            (props.limits as { runBudgetMicrodollars: number }).runBudgetMicrodollars,
            750_000,
          );
          assert.deepEqual(Object.keys(props.limits as object).sort(), PLAYER_KEYS);
          assert.equal(
            (props.limits as { autoContinueTurns: number }).autoContinueTurns,
            0,
            "a page that could not read the settings never auto-continues",
          );
          assert.deepEqual(props.rules, DEFAULT_GAME_RULES);
        }
        const events = logged.flatMap((line) => {
          try {
            return [JSON.parse(line).event];
          } catch {
            return [];
          }
        });
        assert.equal(events.filter((event) => event === "limits_read_failed").length, 2);
        assert.equal(events.filter((event) => event === "game_rules_read_failed").length, 2);
      } finally {
        await pool.query("ALTER TABLE ctf.settings_away RENAME TO settings");
        restoreEnv(before);
      }
    },
  );
});
