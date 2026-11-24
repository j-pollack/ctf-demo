import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { Pool } from "pg";
import { migrateFreshDatabase } from "../../scripts/monitor-investigate-eval-live";
import { closePool } from "./postgres";

// Worker drain (docs/plans/worker-handover.md, D1 to D6): the real worker and drain script run as
// child processes against real Postgres. Only OpenRouter is faked, inside the worker child.
const base = new URL(process.env.CTF_INTEGRATION_DATABASE_URL ?? "http://missing");
assert.equal(process.env.NODE_ENV, "test", "Use npm run test:integration");
assert.equal(base.hostname, "127.0.0.1");
assert.match(base.pathname, /^\/ctf_integration_[a-f0-9]{32}$/);
const adminUrl = new URL(base);
adminUrl.pathname = "/postgres";
const urlFor = (database: string) => {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url;
};
const newName = () => `ctf_integration_${randomUUID().replaceAll("-", "")}`;
const sql = (file: string) => readFile(new URL(`../../db/${file}`, import.meta.url), "utf8");
const until = async (condition: () => boolean | Promise<boolean>, what: string, ms = 20_000) => {
  const deadline = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${what}.`);
    await delay(25);
  }
};

await test("the worker drain", { timeout: 180_000 }, async (t) => {
  const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
  const [main, empty] = [newName(), newName()];
  for (const name of [main, empty]) await admin.query(`CREATE DATABASE "${name}"`);
  const pool = new Pool({
    connectionString: urlFor(main).toString(),
    max: 10,
    options: "-c search_path=ctf,public",
  });
  (globalThis as typeof globalThis & { ctfPool?: Pool }).ctfPool = pool;
  const scratch = await mkdtemp(join(tmpdir(), "worker-drain-"));
  t.after(async () => {
    await killChildren();
    await closePool(pool);
    for (const name of [main, empty]) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end();
    await rm(scratch, { recursive: true, force: true });
  });
  await migrateFreshDatabase(pool);
  await pool.query(await sql("migrations/017-settings.sql"));
  process.env.OPENROUTER_API_KEY = "synthetic-drain-key";

  const { persistReviewedSessionMessages, releaseSessionLease } =
    await import("../../lib/sessions");
  const { WAKE_KEY } = await import("../../lib/worker-wake");
  const { FLAG_READ_MONITOR_VERSION } = await import("../../lib/control");
  const { hashSecret } = await import("../../lib/policy");

  type Row = { url: string; instance: string | null; token: string };
  const readValue = async () =>
    (await pool.query("SELECT value FROM ctf.settings WHERE key=$1", [WAKE_KEY])).rows[0]?.value as
      | string
      | undefined;
  const readRow = async () => JSON.parse((await readValue()) ?? "null") as Row | null;
  const setRow = (value: unknown) =>
    pool.query(
      `INSERT INTO ctf.settings(key,value) VALUES($1,$2)
       ON CONFLICT (key) DO UPDATE SET value=excluded.value`,
      [WAKE_KEY, typeof value === "string" ? value : JSON.stringify(value)],
    );
  const reset = async () => {
    await pool.query("DELETE FROM ctf.settings WHERE key=$1", [WAKE_KEY]);
    await pool.query("TRUNCATE ctf.games CASCADE");
  };

  // Killed when the subtest that started them ends, pass or fail, and before the databases drop.
  const children: ReturnType<typeof spawn>[] = [];
  const killChildren = async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode !== null) continue;
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  };
  t.afterEach(killChildren);
  const run = (script: string, preload: string, database: string, args: string[], extra = {}) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--import", preload, script, ...args],
      {
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          NODE_ENV: "test",
          CTF_INTEGRATION_DATABASE_URL: urlFor(database).toString(),
          ...extra,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    children.push(child);
    let output = "";
    child.stdout.on("data", (chunk) => (output += String(chunk)));
    child.stderr.on("data", (chunk) => (output += String(chunk)));
    return { child, exited: once(child, "exit"), output: () => output };
  };
  // A worker with no Fly environment registers a loopback address. Its review is held until the
  // control file exists.
  const startWorker = async (extra: Record<string, string> = {}) => {
    await reset();
    const release = join(scratch, `release-${randomUUID()}`);
    const worker = run(
      "scripts/monitor-worker.ts",
      "./tests/integration/held-worker-preload.ts",
      main,
      [],
      { HELD_REVIEW_RELEASE_FILE: release, ...extra },
    );
    await until(async () => (await readValue()) !== undefined, "the registration", 30_000);
    const row = (await readRow())!;
    const send = (path: string, authorization?: string) =>
      fetch(new URL(path, row.url), {
        method: "POST",
        headers: authorization ? { authorization } : {},
      });
    return {
      ...worker,
      row,
      release: () => writeFile(release, ""),
      drain: () => send("/drain", `Bearer ${row.token}`),
      send,
    };
  };

  const seedReview = async (options: { finalizing?: boolean } = {}) => {
    const id = randomUUID();
    const lease = randomUUID();
    await pool.query(
      `INSERT INTO ctf.games
       (id,owner_id,sprite_name,secret_hash,agent_model,monitor_model,monitor_version,
        token_budget,status,agent_effort,system_prompt,monitor_mode,submission_transport)
       VALUES($1,$2,$3,$4,'synthetic-agent','synthetic-monitor',$5,1000,$6,'medium','','async','tool')`,
      [
        id,
        `drain-${id}`,
        `ctf-${id}`,
        hashSecret(`flag{${"c".repeat(32)}}`),
        FLAG_READ_MONITOR_VERSION,
        "active",
      ],
    );
    await pool.query(
      `INSERT INTO ctf.agent_sessions
       (id,game_id,ordinal,agent_model,agent_effort,system_prompt,lease,lease_until)
       VALUES($1,$1,1,'synthetic-agent','medium','',$2,now()+interval '1 minute')`,
      [id, lease],
    );
    const instruction = `instruction ${randomUUID()}`;
    // The instruction's stored screen is unclear: the signal that has the worker investigate it.
    const ref = createHash("sha256").update(instruction).digest("hex");
    await pool.query(
      `INSERT INTO ctf.text_screens
       (game_id,session_id,kind,ref,text_sha256,question_set,answers,model,input_tokens,duration_ms)
       VALUES($1,$1,'instruction',$2,$2,'player-v2',$3,'synthetic-screen',0,0)`,
      [id, ref, JSON.stringify({ overrides_rules: 0.6 })],
    );
    await persistReviewedSessionMessages(
      id,
      id,
      lease,
      [{ role: "user", content: instruction, timestamp: Date.now() }] as never,
      1,
      0,
    );
    // The run submits while its last response still holds the session, so the job is claimed as final.
    if (options.finalizing) {
      await pool.query(
        `UPDATE ctf.games SET status='finalizing',submitted_flag_correct=false,
         submitted_session_id=$1 WHERE id=$1`,
        [id],
      );
      await pool.query("INSERT INTO ctf.finalization_jobs(game_id) VALUES($1)", [id]);
    }
    await releaseSessionLease(id, id, lease);
    return id;
  };
  const jobStatus = async (game: string) =>
    (await pool.query("SELECT status FROM ctf.monitor_jobs WHERE game_id=$1", [game])).rows[0]
      ?.status as string | undefined;
  const startReview = async () => {
    const game = await seedReview();
    await until(async () => (await jobStatus(game)) === "reviewing", "the review to start");
    return game;
  };

  await t.test("D1: a drain lets the held review finish and takes no new work", async () => {
    const worker = await startWorker();
    const first = await startReview();
    assert.equal((await worker.send("/drain", "Bearer wrong")).status, 401);
    assert.equal((await worker.send("/drain")).status, 401);
    await delay(1_500);
    assert.ok(await readValue(), "an unauthenticated drain leaves the row in place");
    assert.ok(!worker.output().includes("drained"), "and does not drain the worker");
    assert.equal((await worker.drain()).status, 204);
    assert.equal((await worker.drain()).status, 204, "a second drain changes nothing");

    // A pass between its finalize and claim steps when the drain arrived may still claim, so the
    // second job is queued only after one idle poll has passed.
    await delay(1_500);
    const second = await seedReview();
    await delay(2_500);
    assert.equal(await jobStatus(second), "queued", "no new review starts while one is held");
    assert.equal(await jobStatus(first), "reviewing");
    assert.ok(await readValue(), "the row stays while the review runs");

    await worker.release();
    await until(async () => (await readValue()) === undefined, "the row to be removed");
    const verdicts = await pool.query("SELECT verdict FROM ctf.monitor_reviews WHERE game_id=$1", [
      first,
    ]);
    assert.deepEqual(
      verdicts.rows.map((row) => row.verdict),
      ["allow"],
    );
    assert.equal(await jobStatus(first), "caught-up", "the held review was finalized once");
    await delay(2_500);
    assert.equal(await jobStatus(second), "queued", "still unclaimed after the release");
    assert.equal(worker.child.exitCode, null, worker.output());
    worker.child.kill("SIGTERM");
    await worker.exited;
  });

  await t.test("B2-8: a drain lets a claimed final review finish and claims no other", async () => {
    const worker = await startWorker();
    const first = await seedReview({ finalizing: true });
    await until(async () => (await jobStatus(first)) === "reviewing", "the final review to start");
    const routeOf = async (game: string) =>
      (await pool.query("SELECT route FROM ctf.monitor_reviews WHERE game_id=$1", [game])).rows.map(
        (row) => row.route,
      );
    await until(async () => (await routeOf(first)).includes("final"), "the review's route");
    assert.equal((await worker.drain()).status, 204);
    await delay(1_500);
    const second = await seedReview({ finalizing: true });
    await delay(2_500);
    assert.equal(await jobStatus(second), "queued", "no new final review starts while draining");
    assert.equal(await jobStatus(first), "reviewing");

    await worker.release();
    await until(async () => (await readValue()) === undefined, "the row to be removed");
    const [job] = (
      await pool.query(
        "SELECT status,final_version,requested_version FROM ctf.monitor_jobs WHERE game_id=$1",
        [first],
      )
    ).rows;
    assert.equal(job.status, "caught-up");
    assert.equal(Number(job.final_version), Number(job.requested_version));
    assert.deepEqual(await routeOf(first), ["final"]);
    await delay(2_500);
    assert.equal(await jobStatus(second), "queued", "still unclaimed after the release");
    worker.child.kill("SIGTERM");
    await worker.exited;
  });

  await t.test("D2: a drained idle worker exits 0 on SIGTERM", async () => {
    const worker = await startWorker();
    assert.equal((await worker.drain()).status, 204);
    await until(async () => (await readValue()) === undefined, "the row to be removed");
    await until(() => worker.output().includes("monitor.worker.drained"), "the idle state");
    await delay(500);
    assert.equal(worker.child.exitCode, null, "a drained worker does not exit by itself");
    const signalled = Date.now();
    worker.child.kill("SIGTERM");
    const [code] = await worker.exited;
    assert.equal(code, 0, worker.output());
    assert.ok(Date.now() - signalled < 3_000);
  });

  await t.test("D3: a drained worker that gets no signal exits 1 when its wait ends", async () => {
    const worker = await startWorker({ WORKER_DRAIN_IDLE_MS: "1500" });
    assert.equal((await worker.drain()).status, 204);
    const [code] = await worker.exited;
    assert.equal(code, 1, worker.output());
    assert.equal(await readValue(), undefined);
  });

  await t.test("D4: SIGTERM during a drain exits 0 once the held review ends", async () => {
    const worker = await startWorker();
    const game = await startReview();
    assert.equal((await worker.drain()).status, 204);
    worker.child.kill("SIGTERM");
    await delay(1_000);
    assert.equal(worker.child.exitCode, null, "the review is still held");
    await worker.release();
    const released = Date.now();
    const [code] = await worker.exited;
    assert.equal(code, 0, worker.output());
    assert.ok(Date.now() - released < 30_000, "it does not wait out the idle limit");
    assert.equal(await readValue(), undefined);
    assert.equal(
      (
        await pool.query("SELECT count(*)::int AS n FROM ctf.monitor_reviews WHERE game_id=$1", [
          game,
        ])
      ).rows[0].n,
      1,
    );
  });

  const drainScript = (origin: string, wait: string, database = main) =>
    run("scripts/drain-worker.ts", "./tests/integration/pool-preload.ts", database, [origin, wait]);
  const originOf = (url: string) => new URL(url).origin;

  await t.test("D5: the drain script drains a real worker and waits for its row", async () => {
    const worker = await startWorker();
    const token = worker.row.token;
    const game = await startReview();
    const script = drainScript(originOf(worker.row.url), "60");
    await delay(2_500);
    assert.equal(script.child.exitCode, null, "the script waits for the held review");
    assert.ok(await readValue(), "the row is still present");
    await worker.release();
    const [code] = await script.exited;
    assert.equal(code, 0, script.output());
    assert.equal(await readValue(), undefined, "the row is gone when the script returns");
    const verdicts = await pool.query("SELECT verdict FROM ctf.monitor_reviews WHERE game_id=$1", [
      game,
    ]);
    assert.deepEqual(
      verdicts.rows.map((row) => row.verdict),
      ["allow"],
    );
    assert.match(script.output(), /worker\.drain\.drained/);
    assert.ok(!script.output().includes(token), "no token in the output");
    assert.ok(!script.output().includes(base.toString()), "no database URL in the output");
    assert.ok(!script.output().includes(base.host), "no database host in the output");
    worker.child.kill("SIGTERM");
    await worker.exited;
  });

  type Stub = { origin: string; requests: string[]; server: Server };
  const stub = async (status: number): Promise<Stub> => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(`${request.method} ${request.url} ${request.headers.authorization}`);
      request.resume();
      response.writeHead(status).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    );
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { origin, requests, server };
  };
  const token = "d".repeat(64);

  await t.test(
    "D6: the drain script sends nothing it should not and never blocks a deploy",
    async () => {
      const live = await stub(204);
      const expected = live.origin;
      const exitOf = async (wait = "1") => {
        const script = drainScript(expected, wait);
        const [code] = await script.exited;
        assert.ok(!script.output().includes(token));
        return { code, output: script.output() };
      };

      await reset();
      let result = await exitOf();
      assert.equal(result.code, 0);
      assert.match(result.output, /nothing/);

      await setRow(`{"token":"${token}"`);
      result = await exitOf();
      assert.equal(result.code, 0);
      assert.match(result.output, /malformed/);

      const other = await stub(204);
      await setRow({ url: `${other.origin}/wake`, instance: null, token });
      result = await exitOf();
      assert.equal(result.code, 0);
      assert.match(result.output, /origin/);
      assert.deepEqual(other.requests, [], "another origin is never called");
      assert.deepEqual(live.requests, []);

      const missing = await stub(404);
      await setRow({ url: `${missing.origin}/wake`, instance: null, token });
      const script = drainScript(missing.origin, "1");
      assert.equal((await script.exited)[0], 0);
      assert.match(script.output(), /status 404/);
      assert.deepEqual(missing.requests, [`POST /drain Bearer ${token}`]);

      const dead = await stub(204);
      await new Promise<void>((resolve) => dead.server.close(() => resolve()));
      await setRow({ url: `${dead.origin}/wake`, instance: null, token });
      const refused = drainScript(dead.origin, "1");
      assert.equal((await refused.exited)[0], 0);
      assert.match(refused.output(), /worker\.drain\.failed/);

      await setRow({ url: `${live.origin}/wake`, instance: null, token });
      result = await exitOf("1");
      assert.equal(result.code, 0);
      assert.match(result.output, /timeout/, "a row that never goes away ends the wait");
      assert.deepEqual(live.requests, [`POST /drain Bearer ${token}`]);

      const unreadable = drainScript(expected, "1", empty);
      const [code] = await unreadable.exited;
      assert.notEqual(code, 0, "a failed first read fails the deploy");
      assert.ok(!unreadable.output().includes(base.host));

      for (const args of [
        [expected, "0"],
        [expected, "soon"],
        ["not a url", "1"],
      ]) {
        const bad = run(
          "scripts/drain-worker.ts",
          "./tests/integration/pool-preload.ts",
          main,
          args,
        );
        assert.notEqual((await bad.exited)[0], 0, args.join(" "));
        assert.match(bad.output(), /worker\.drain\.usage/);
      }
      await reset();
    },
  );
  await t.test("D7: a drained worker retries the delete of its row until it works", async () => {
    await reset();
    const { startWakeEndpoint } = await import("../../lib/monitor-wake-server");
    const logged: string[] = [];
    t.mock.method(console, "error", (line: unknown) => {
      logged.push(String(line));
    });
    const endpoint = await startWakeEndpoint(
      () => {},
      () => {},
    );
    assert.ok(await readValue());
    await pool.query("ALTER TABLE ctf.settings RENAME TO settings_off");
    let renamed = true;
    try {
      let resolved = false;
      const stopped = endpoint.stop(true).then(() => (resolved = true));
      await until(
        () => logged.some((line) => line.includes("worker.wake.unregister.failed")),
        "the first failed delete",
      );
      assert.equal(resolved, false, "stop keeps retrying while the delete fails");
      await pool.query("ALTER TABLE ctf.settings_off RENAME TO settings");
      renamed = false;
      await stopped;
    } finally {
      if (renamed) await pool.query("ALTER TABLE ctf.settings_off RENAME TO settings");
    }
    assert.equal(await readValue(), undefined, "the row is removed once the delete works");
  });
});
