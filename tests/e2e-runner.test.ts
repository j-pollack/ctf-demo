import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertSafeEnv,
  e2eEnv,
  emptyNames,
  envFileNames,
  failureEvents,
  newLines,
  runProblems,
  assertWorkerEnv,
  workerExitProblem,
  WORKER_LOG,
  WORKER_LOG_CURSOR_FILE,
  SPRITE_DIR,
  SERVER_LOG,
  LOG_CURSOR_FILE,
  type Stage,
} from "../scripts/test-e2e";

const stack = { port: 3123, dbPort: "55432", database: "ctf_e2e_0123456789abcdef0123456789abcdef" };
const stages: Stage[] = ["build", "migrate", "server", "test"];
const REAL = "REAL-SECRET-VALUE";
const files = {
  ".env.local": `DATABASE_URL=${REAL}\nexport OPENROUTER_API_KEY=${REAL}\n# COMMENTED=1\nSITE_URL = ${REAL}\n`,
  ".env.production.local": `ADMIN_EMAILS=${REAL}\nONLY_IN_PRODUCTION=${REAL}\n`,
  ".env.example": "FASTMAIL_API_TOKEN=\n",
  "notes.txt": `NOT_AN_ENV_FILE=${REAL}\n`,
};
const names = envFileNames(files);
const inherited = {
  PATH: "/usr/bin",
  HOME: "/home/tester",
  AWS_SECRET_ACCESS_KEY: REAL,
  DATABASE_URL: REAL,
  ONLY_IN_PRODUCTION: REAL,
  NODE_ENV: "test",
};
const env = (stage: Stage) => e2eEnv(stage, { inherited, fileNames: names, stack });

test("E1: names come from every .env* file and nothing else", () => {
  assert.deepEqual(names, [
    "ADMIN_EMAILS",
    "DATABASE_URL",
    "FASTMAIL_API_TOKEN",
    "ONLY_IN_PRODUCTION",
    "OPENROUTER_API_KEY",
    "SITE_URL",
  ]);
});

test("E1: no stage sees a real value, an unlisted variable or the test mode", () => {
  for (const stage of stages) {
    const built = env(stage);
    assert.equal(
      Object.values(built).some((value) => value?.includes(REAL)),
      false,
      stage,
    );
    assert.equal(built.AWS_SECRET_ACCESS_KEY, undefined, stage);
    assert.equal(built.NODE_ENV, undefined, stage);
    assert.equal(built.PATH, "/usr/bin", stage);
    assert.equal(built.ONLY_IN_PRODUCTION, "", stage);
    assert.equal(built.NEXT_TELEMETRY_DISABLED, "1", stage);
    assert.doesNotThrow(() => assertSafeEnv(stage, built), stage);
  }
});

test("E1: the server, migration and tests reach only the loopback database", () => {
  for (const stage of ["migrate", "server", "test"] as const) {
    const built = env(stage);
    assert.equal(built.DATABASE_URL, "", stage);
    assert.equal(built.DATABASE_URL_UNPOOLED, "", stage);
    assert.equal(built.PGHOST, "127.0.0.1", stage);
    assert.equal(built.PGPORT, stack.dbPort, stage);
    assert.equal(built.PGDATABASE, stack.database, stage);
  }
  const build = env("build");
  assert.equal(build.DATABASE_URL, "");
  assert.equal(build.DATABASE_URL_UNPOOLED, "postgresql://unavailable:unavailable@127.0.0.1:1/ctf");
});

test("E1: only the server loads the preload, and the auth origin is the browser's origin", () => {
  assert.match(
    env("server").NODE_OPTIONS ?? "",
    /--import tsx --import \S+tests\/e2e\/preload\.ts/,
  );
  for (const stage of ["build", "migrate", "test"] as const)
    assert.equal(env(stage).NODE_OPTIONS, undefined, stage);
  for (const stage of ["build", "server"] as const)
    assert.equal(env(stage).BETTER_AUTH_URL, "http://127.0.0.1:3123", stage);
  assert.equal(env("test").E2E_BASE_URL, "http://127.0.0.1:3123");
  for (const name of ["SITE_URL", "TRIPWIRE_COOKIE_PREFIX", "ADMIN_EMAILS"])
    assert.equal(env("server")[name], "", name);
});

test("A8: the server has a synthetic Fastmail token and contact address, and the tests know the address", () => {
  const server = env("server");
  assert.match(server.FASTMAIL_API_TOKEN ?? "", /^e2e-/);
  assert.ok(!server.FASTMAIL_API_TOKEN?.includes(REAL));
  assert.equal(server.CONTACT_EMAIL, "contact@ctf.example.test");
  assert.equal(env("test").CONTACT_EMAIL, "contact@ctf.example.test");
  assert.equal(env("test").FASTMAIL_API_TOKEN, "");
  for (const stage of ["build", "migrate"] as const) {
    assert.equal(env(stage).FASTMAIL_API_TOKEN, "", stage);
    assert.equal(env(stage).CONTACT_EMAIL, "", stage);
  }
});

test("E1: the spawn guard refuses a reachable or remote database", () => {
  const good = env("server");
  for (const bad of [
    { DATABASE_URL: "postgresql://real.example/db" },
    { DATABASE_URL_UNPOOLED: "postgresql://real.example/db" },
    { PGHOST: "db.example.com" },
    { PGHOST: undefined },
  ])
    assert.throws(
      () => assertSafeEnv("server", { ...good, ...bad }),
      /database/i,
      JSON.stringify(bad),
    );
  assert.throws(
    () => assertSafeEnv("build", { ...env("build"), DATABASE_URL_UNPOOLED: "postgresql://x/y" }),
    /database/i,
  );
});

test("E1: the preload is told which names must stay empty", () => {
  const built = env("server");
  const empty = emptyNames(built, names);
  for (const name of ["DATABASE_URL", "SITE_URL", "ADMIN_EMAILS"])
    assert.ok(empty.includes(name), name);
  assert.ok(empty.includes("ONLY_IN_PRODUCTION"));
  assert.ok(!empty.includes("OPENROUTER_API_KEY"), "a synthetic value is not a blank");
  assert.ok(!empty.includes("FASTMAIL_API_TOKEN"), "a synthetic value is not a blank");
  assert.ok(!empty.includes("CONTACT_EMAIL"), "a synthetic value is not a blank");
});

test("A7: failure events are the JSON lines whose event ends in failed, and the unawaited task", () => {
  const route = '{"event":"route.failed","error":"boom"}';
  const read = '{"event":"limits_read_failed","error":"down"}';
  const notify = '{"event":"feedback_mail.notify_failed","error":"x"}';
  const rule = '{"event":"game_rule_change_failed","error":"x"}';
  const unawaited = '{"event":"auth.background_task_unawaited","error":"x"}';
  assert.deepEqual(
    failureEvents([
      "ready in 100ms",
      '{"event":"auth.email.sent","purpose":"sign-in"}',
      route,
      read,
      notify,
      rule,
      unawaited,
      '{"event":"failed_over_to_backup"}',
      '{"event":"the word failed inside"}',
      '{"message":"failed"}',
      '{"event":7}',
      "not json {",
      "null",
    ]).map((entry) => JSON.stringify(entry)),
    [route, read, notify, rule, unawaited],
  );
});

test("A7: new lines stop at the last newline, so a half-written line is not consumed", () => {
  const log = Buffer.from('one\n{"event":"a_failed"}\n{"event":"b_fai');
  const first = newLines(log, 0);
  assert.deepEqual(first.lines, ["one", '{"event":"a_failed"}']);
  assert.equal(first.offset, Buffer.byteLength('one\n{"event":"a_failed"}\n'));
  assert.deepEqual(newLines(log, first.offset), { lines: [], offset: first.offset });
  const done = Buffer.concat([log, Buffer.from('led"}\n')]);
  assert.deepEqual(newLines(done, first.offset).lines, ['{"event":"b_failed"}']);
  // Offsets count bytes, not characters.
  assert.deepEqual(newLines(Buffer.from("é\nx\n"), 3), { lines: ["x"], offset: 5 });
});

test("A7: the tests are told where the server log and its cursor are", () => {
  const built = env("test");
  assert.equal(built.E2E_SERVER_LOG, SERVER_LOG);
  assert.equal(built.E2E_LOG_CURSOR, LOG_CURSOR_FILE);
  assert.notEqual(SERVER_LOG, LOG_CURSOR_FILE);
});

test("E1: names follow the grammar of the dotenv that Next loads", () => {
  const text = [
    "FLY_API_TOKEN: colon-form",
    "DOTTED.NAME=1",
    "HYPHEN-NAME=1",
    "export EXPORTED_NAME=1",
    "SPACE_BEFORE_COLON : x",
    "NO_SPACE_AFTER_COLON:x",
    "# COMMENTED=1",
  ].join("\n");
  assert.deepEqual(envFileNames({ ".env.preview": text }), [
    "DOTTED.NAME",
    "EXPORTED_NAME",
    "FLY_API_TOKEN",
    "HYPHEN-NAME",
  ]);
});

test("C6: the server and tests share the Sprite directory, and the server names the submission host", () => {
  assert.equal(env("server").E2E_SPRITE_DIR, SPRITE_DIR);
  assert.equal(env("test").E2E_SPRITE_DIR, SPRITE_DIR);
  assert.equal(env("server").VERCEL_URL, "ctf.e2e.test");
  assert.equal(env("server").SITE_URL, "");
  assert.equal(env("test").CRON_SECRET, env("server").CRON_SECRET);
  assert.match(env("test").CRON_SECRET ?? "", /^e2e-/);
  for (const stage of ["build", "migrate"] as const)
    assert.equal(env(stage).E2E_SPRITE_DIR, undefined, stage);
});

test("C6: a screen that timed out is a failure event", () => {
  const timeout = '{"event":"text_screen.request_timed_out","kind":"instruction"}';
  assert.deepEqual(
    failureEvents([timeout]).map((entry) => JSON.stringify(entry)),
    [timeout],
  );
});

test("C6: after the stories no run is open and the Sprite directories are the undeleted runs' Sprites", () => {
  const run = (id: string, status: string, deleted: boolean) => ({
    id,
    sprite_name: `ctf-${id}`,
    status,
    sprite_deleted_at: deleted ? new Date() : null,
    unfinished_finalizations: 0,
    unsettled_jobs: 0,
    review_errors: [],
  });
  const clean = [run("a", "ended", true), run("b", "caught", false)];
  assert.deepEqual(runProblems(clean, ["ctf-b"], true), []);
  assert.equal(
    runProblems([run("a", "active", false), ...clean], ["ctf-a", "ctf-b"], true).length,
    1,
  );
  assert.equal(runProblems([run("c", "creating", true)], [], true).length, 1);
  assert.equal(runProblems(clean, [], true).length, 1, "an undeleted Sprite has no directory");
  assert.equal(runProblems(clean, ["ctf-a", "ctf-b"], true).length, 1, "a deleted Sprite is left");
  assert.equal(runProblems([], [], true).length, 1, "no run at all proves nothing");
  assert.deepEqual(runProblems([], [], false), []);
});

test("W1: the server and the worker share one environment, and the tests know the worker's log and the app's origin", () => {
  assert.equal(env("server").E2E_APP_ORIGIN, "http://127.0.0.1:3123");
  assert.equal(env("test").E2E_WORKER_LOG, WORKER_LOG);
  assert.equal(env("test").E2E_WORKER_LOG_CURSOR, WORKER_LOG_CURSOR_FILE);
  assert.notEqual(WORKER_LOG, WORKER_LOG_CURSOR_FILE);
  assert.notEqual(WORKER_LOG, SERVER_LOG);
});

test("W1: the worker is refused an environment without the preload, its files or a safe database", () => {
  const good = env("server");
  assert.doesNotThrow(() => assertWorkerEnv(good));
  for (const bad of [
    { NODE_OPTIONS: "--import tsx" },
    { NODE_OPTIONS: undefined },
    { E2E_VIOLATIONS_FILE: "" },
    { E2E_MAIL_FILE: undefined },
    { E2E_SPRITE_DIR: "" },
    { VERCEL_URL: "" },
    { PGHOST: "db.example.com" },
    { DATABASE_URL: "postgresql://real.example/db" },
  ])
    assert.throws(
      () => assertWorkerEnv({ ...good, ...bad }),
      /worker|database/i,
      JSON.stringify(bad),
    );
});

test("W1: a worker that exits before it is stopped, or with a non-zero code, is a problem", () => {
  assert.equal(workerExitProblem(0, null, true), undefined);
  assert.match(workerExitProblem(0, null, false) ?? "", /exited early/);
  assert.match(workerExitProblem(null, "SIGKILL", false) ?? "", /SIGKILL/);
  assert.match(workerExitProblem(1, null, true) ?? "", /code 1/);
  assert.match(workerExitProblem(null, "SIGKILL", true) ?? "", /SIGKILL/);
});

test("W4: after the stories no run is finalizing, and no finalization, job or review is left open", () => {
  const base = {
    id: "a",
    sprite_name: "ctf-a",
    status: "captured",
    sprite_deleted_at: null,
    unfinished_finalizations: 0,
    unsettled_jobs: 0,
    review_errors: [] as string[],
  };
  assert.deepEqual(runProblems([base], ["ctf-a"], true), []);
  const cases: [Partial<typeof base>, RegExp][] = [
    [{ status: "finalizing" }, /finalizing/],
    [{ unfinished_finalizations: 1 }, /finalization/],
    [{ unsettled_jobs: 2 }, /monitor job/],
    [{ review_errors: ["boom"] }, /boom/],
  ];
  for (const [over, pattern] of cases) {
    const problems = runProblems([{ ...base, ...over }], ["ctf-a"], true);
    assert.equal(problems.length, 1, JSON.stringify(over));
    assert.match(problems[0], pattern);
  }
});
