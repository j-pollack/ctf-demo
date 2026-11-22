import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { Pool } from "pg";
import { migrateFreshDatabase } from "../../scripts/monitor-investigate-eval-live";
import { closePool } from "./postgres";
import { fastMonitorTiming } from "./monitor-timing";
import { streamedCompletion } from "./completion-stream";

// The idle monitor worker (docs/plans/worker-idle-wake.md, W2 to W5 and W7), driven through the real
// application paths, wake server, loop and Postgres. Only OpenRouter is faked; wake requests go to
// real local servers.
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
const until = async (condition: () => boolean | Promise<boolean>, what: string, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${what}.`);
    await delay(25);
  }
};
const realFetch = globalThis.fetch;

await test("the idle monitor worker", { timeout: 120_000 }, async (t) => {
  const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
  const databases = [newName(), newName(), newName()];
  const [main, bare, full] = databases;
  for (const name of databases) await admin.query(`CREATE DATABASE "${name}"`);
  const pool = new Pool({
    connectionString: urlFor(main).toString(),
    max: 10,
    options: "-c search_path=ctf,public",
  });
  (globalThis as typeof globalThis & { ctfPool?: Pool }).ctfPool = pool;
  t.after(async () => {
    await closePool(pool);
    for (const name of databases) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end();
  });
  await migrateFreshDatabase(pool);
  await pool.query(await sql("migrations/017-settings.sql"));
  process.env.OPENROUTER_API_KEY = "synthetic-idle-key";

  const { claimMonitorJob, finishMonitorJob, hasPendingWork } =
    await import("../../lib/monitor-jobs");
  const { startWakeEndpoint } = await import("../../lib/monitor-wake-server");
  const { wakeWorker, WAKE_KEY } = await import("../../lib/worker-wake");
  const { persistReviewedSessionMessages, releaseSessionLease } =
    await import("../../lib/sessions");
  const { completeAsyncCommand } = await import("../../lib/monitor-commands");
  const { receiveFlagSubmission, hashSubmissionToken } = await import("../../lib/flag-submissions");
  const { beginAsyncSubmission } = await import("../../lib/async-finalization");
  const { runMonitorWorkerOnce } = await import("../../lib/monitor-worker");
  const { createWorkerLoops, realClock } = await import("../../lib/monitor-worker-loop");
  const { FLAG_READ_MONITOR_VERSION } = await import("../../lib/control");
  const { hashSecret, MODELS } = await import("../../lib/policy");
  const { TYPESAFE_MODEL } = await import("../../lib/typesafe");

  // The only fake: OpenRouter. Wake requests go to the real local servers; anything else fails.
  const unexpected: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const endpoint = String(input);
    if (endpoint.startsWith("http://127.0.0.1:")) return realFetch(input, init);
    if (endpoint === "https://openrouter.ai/api/v1/models")
      return Response.json({
        data: MODELS.map((id) => ({
          id,
          context_length: 200_000,
          pricing: { prompt: "0.000001", completion: "0.000002" },
          supported_parameters: ["tools", "reasoning"],
        })),
      });
    if (endpoint === "https://openrouter.ai/api/v1/systemone") {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, TYPESAFE_MODEL);
      return Response.json({
        answers: {
          intent: { type: "noul", noul: 0 },
          suspicion: { type: "score", score: 0, confidence: 1 },
        },
        usage: { input_tokens: 10 },
      });
    }
    if (endpoint === "https://openrouter.ai/api/v1/chat/completions")
      return streamedCompletion(init, {
        id: `synthetic-${randomUUID()}`,
        choices: [
          {
            message: {
              role: "assistant",
              tool_calls: [
                {
                  id: randomUUID(),
                  type: "function",
                  function: {
                    name: "finish_investigation",
                    arguments: JSON.stringify({
                      flagReadDetected: false,
                      reason: "No evidenced read.",
                      evidence: [],
                    }),
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130, cost: 0.00001 },
      });
    unexpected.push(endpoint);
    throw new Error(`Unexpected request to ${endpoint}`);
  });
  const logged: string[] = [];
  t.mock.method(console, "error", (line: unknown) => {
    logged.push(String(line));
  });
  t.afterEach(() => {
    assert.deepEqual(unexpected, []);
  });

  const FLAG = `flag{${"b".repeat(32)}}`;
  const seedGame = async (options: { http?: boolean } = {}) => {
    const id = randomUUID();
    const lease = randomUUID();
    await pool.query(
      `INSERT INTO ctf.games
       (id,owner_id,sprite_name,secret_hash,agent_model,monitor_model,monitor_version,
        token_budget,status,agent_effort,system_prompt,monitor_mode,submission_transport)
       VALUES($1,$2,$3,$4,'synthetic-agent','synthetic-monitor',$5,1000,'active','medium','','async',$6)`,
      [
        id,
        `idle-${id}`,
        `ctf-${id}`,
        hashSecret(FLAG),
        FLAG_READ_MONITOR_VERSION,
        options.http ? "http" : "tool",
      ],
    );
    await pool.query(
      `INSERT INTO ctf.agent_sessions
       (id,game_id,ordinal,agent_model,agent_effort,system_prompt,lease,lease_until)
       VALUES($1,$1,1,'synthetic-agent','medium','',$2,now()+interval '1 minute')`,
      [id, lease],
    );
    return { id, lease };
  };
  const saveMessage = (game: { id: string; lease: string }) =>
    persistReviewedSessionMessages(
      game.id,
      game.id,
      game.lease,
      [{ role: "user", content: `instruction ${randomUUID()}`, timestamp: Date.now() }] as never,
      1,
      0,
    );
  const setRow = (value: unknown) =>
    pool.query(
      `INSERT INTO ctf.settings(key,value) VALUES($1,$2)
       ON CONFLICT (key) DO UPDATE SET value=excluded.value`,
      [WAKE_KEY, typeof value === "string" ? value : JSON.stringify(value)],
    );
  const clearRow = () => pool.query("DELETE FROM ctf.settings WHERE key=$1", [WAKE_KEY]);
  const reset = async () => {
    await clearRow();
    await pool.query("DELETE FROM ctf.monitor_jobs");
    await pool.query("DELETE FROM ctf.finalization_jobs");
    logged.length = 0;
  };

  type Received = { authorization?: string; instance?: string };
  const listen = async () => {
    const received: Received[] = [];
    const server = createServer((request, response) => {
      received.push({
        authorization: request.headers.authorization,
        instance: request.headers["fly-force-instance-id"] as string | undefined,
      });
      response.writeHead(request.method === "POST" && request.url === "/wake" ? 204 : 404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => closeServer(server));
    return { received, port: (server.address() as AddressInfo).port };
  };
  const closeServer = (server: Server) =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });

  await t.test("W2: pending work is exactly what the worker must act on", async () => {
    await reset();
    assert.equal(await hasPendingWork(), false, "an empty database");
    const monitorJob = async (status: string) => {
      const game = await seedGame();
      await pool.query(
        `INSERT INTO ctf.monitor_jobs(id,game_id,session_id,epoch,start_version,requested_version,status)
         VALUES($1,$2,$2,1,1,1,$3)`,
        [randomUUID(), game.id, status],
      );
    };
    for (const status of ["caught-up", "unresolved", "caught"]) await monitorJob(status);
    const finalization = async (
      jobStatus: string,
      run: { status?: string; error?: string } = {},
    ) => {
      const game = await seedGame();
      await pool.query("UPDATE ctf.games SET status=$2,finalization_error=$3 WHERE id=$1", [
        game.id,
        run.status ?? "finalizing",
        run.error ?? null,
      ]);
      await pool.query("INSERT INTO ctf.finalization_jobs(game_id,status) VALUES($1,$2)", [
        game.id,
        jobStatus,
      ]);
    };
    await finalization("done");
    await finalization("unresolved");
    await finalization("queued", { status: "caught" });
    await finalization("queued", { error: "scoring failed" });
    assert.equal(await hasPendingWork(), false, "only rows nothing will move");
    await pool.query("DELETE FROM ctf.monitor_jobs");
    await monitorJob("queued");
    assert.equal(await hasPendingWork(), true, "a queued monitor job");
    await pool.query("DELETE FROM ctf.monitor_jobs");
    await monitorJob("reviewing");
    assert.equal(await hasPendingWork(), true, "a reviewing monitor job");
    await reset();
    await finalization("scoring");
    assert.equal(await hasPendingWork(), true, "a scoring finalization job");
    await reset();
    await finalization("queued");
    assert.equal(await hasPendingWork(), true, "a queued job of a finalizing run");
    await reset();
  });

  await t.test("W3: the wake server authenticates and each worker registers itself", async () => {
    await reset();
    const calls = { first: 0, second: 0 };
    const first = await startWakeEndpoint(
      () => calls.first++,
      () => {},
    );
    const read = async () =>
      JSON.parse(
        (await pool.query("SELECT value FROM ctf.settings WHERE key=$1", [WAKE_KEY])).rows[0].value,
      ) as { url: string; instance: string | null; token: string };
    const one = await read();
    assert.equal(one.instance, null);
    assert.match(one.url, /^http:\/\/127\.0\.0\.1:\d+\/wake$/);
    assert.equal(Buffer.from(one.token, "hex").length, 32);
    const send = (url: string, method: string, authorization?: string) =>
      realFetch(url, { method, headers: authorization ? { authorization } : {} });
    assert.equal((await send(one.url, "POST", `Bearer ${one.token}`)).status, 204);
    assert.equal(calls.first, 1);
    assert.equal((await send(one.url, "POST", "Bearer wrong")).status, 401);
    assert.equal((await send(one.url, "POST")).status, 401);
    assert.equal((await send(one.url, "POST", `Bearer ${one.token}x`)).status, 401);
    assert.equal((await send(one.url, "GET", `Bearer ${one.token}`)).status, 404);
    assert.equal(
      (await send(one.url.replace("/wake", "/other"), "POST", `Bearer ${one.token}`)).status,
      404,
    );
    assert.equal(calls.first, 1, "only the authenticated POST woke the loops");

    const second = await startWakeEndpoint(
      () => calls.second++,
      () => {},
    );
    const two = await read();
    assert.notEqual(two.token, one.token);
    wakeWorker();
    await until(() => calls.second === 1, "the second worker's wake");
    assert.equal(calls.first, 1, "the first worker is no longer called");

    await first.stop();
    assert.deepEqual(await read(), two, "a stopped worker leaves another worker's row alone");
    await second.stop();
    assert.equal(
      (await pool.query("SELECT 1 FROM ctf.settings WHERE key=$1", [WAKE_KEY])).rowCount,
      0,
      "a clean exit removes the worker's own row",
    );
    assert.deepEqual(logged, []);
  });

  await t.test(
    "W4: queueing work sends an authenticated wake to the registered worker",
    async () => {
      await reset();
      const target = await listen();
      const token = randomBytes(32).toString("hex");
      await setRow({ url: `http://127.0.0.1:${target.port}/wake`, instance: "machine-1", token });
      const woken = async (count: number) => {
        await until(() => target.received.length >= count, `${count} wake requests`);
        for (const request of target.received) {
          assert.equal(request.authorization, `Bearer ${token}`);
          assert.equal(request.instance, "machine-1", "Fly routes the call to the one machine");
        }
      };

      const message = await seedGame();
      await saveMessage(message);
      await woken(1);
      await delay(150);
      assert.equal(target.received.length, 1, "one saved message sends one wake");

      const command = async (http: boolean) => {
        const game = await seedGame({ http });
        const call = randomUUID();
        const dispatch = randomUUID();
        const token = randomBytes(32).toString("base64url");
        const assistant = {
          role: "assistant",
          content: [
            { type: "toolCall", id: call, name: "sprite_exec", arguments: { command: "x" } },
          ],
          timestamp: 1,
        };
        await pool.query("UPDATE ctf.agent_sessions SET messages=$2 WHERE id=$1", [
          game.id,
          JSON.stringify([assistant]),
        ]);
        await pool.query(
          `INSERT INTO ctf.sprite_operations
         (id,sprite_name,game_id,session_id,tool_call_id,kind,command,execution_generation,
          submission_token_hash,originating_lease)
         VALUES($1,$2,$3,$3,$4,'command','x',0,$5,$6)`,
          [
            dispatch,
            `ctf-${game.id}`,
            game.id,
            call,
            http ? hashSubmissionToken(token) : null,
            game.lease,
          ],
        );
        if (http) assert.equal(await receiveFlagSubmission({ token, value: FLAG }), "accepted");
        const before = target.received.length;
        await completeAsyncCommand({
          dispatchId: dispatch,
          gameId: game.id,
          sessionId: game.id,
          messages: [
            assistant,
            {
              role: "toolResult",
              toolCallId: call,
              toolName: "sprite_exec",
              content: [{ type: "text", text: "out" }],
              isError: false,
              timestamp: 2,
            },
          ] as never,
          outcome: "completed",
          output: "out",
        });
        return { game, before };
      };
      const plain = await command(false);
      await woken(plain.before + 1);
      await delay(150);
      assert.equal(
        target.received.length,
        plain.before + 1,
        "a command that promotes nothing sends one",
      );
      const submitted = await command(true);
      await woken(submitted.before + 2);
      await delay(150);
      assert.equal(
        target.received.length,
        submitted.before + 2,
        "the enqueue and the promotion each wake",
      );
      assert.equal(
        (await pool.query("SELECT status FROM ctf.games WHERE id=$1", [submitted.game.id])).rows[0]
          .status,
        "finalizing",
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM ctf.finalization_jobs WHERE game_id=$1",
            [submitted.game.id],
          )
        ).rows[0].n,
        1,
      );
    },
  );

  await t.test("W4: a missing row or table sends nothing and the write commits", async () => {
    await reset();
    const stored = async (game: { id: string }) =>
      (await pool.query("SELECT turns FROM ctf.agent_sessions WHERE id=$1", [game.id])).rows[0]
        .turns;
    const noRow = await seedGame();
    await saveMessage(noRow);
    assert.equal(await stored(noRow), 1);
    await pool.query("ALTER TABLE ctf.settings RENAME TO settings_off");
    try {
      const noTable = await seedGame();
      await saveMessage(noTable);
      assert.equal(await stored(noTable), 1);
      await delay(200);
    } finally {
      await pool.query("ALTER TABLE ctf.settings_off RENAME TO settings");
    }
    await delay(100);
    assert.deepEqual(logged, [], "neither case is logged as a failure");
  });

  await t.test("W4: a dead or malformed registration is logged without its token", async () => {
    await reset();
    const token = randomBytes(32).toString("hex");
    // A port that nothing listens on: take a free one and close its server.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const deadPort = (probe.address() as AddressInfo).port;
    await closeServer(probe);
    const cases: [string, unknown][] = [
      ["refused", { url: `http://127.0.0.1:${deadPort}/wake`, instance: null, token }],
      ["not json", `{"token":"${token}"`],
      ["remote http", { url: `http://example.invalid/wake`, instance: null, token }],
      ["wrong shape", { url: 7, instance: null, token }],
    ];
    for (const [name, value] of cases) {
      logged.length = 0;
      await setRow(value);
      const game = await seedGame();
      await saveMessage(game);
      await until(() => logged.some((line) => line.includes("worker.wake.failed")), name);
      assert.equal(
        (await pool.query("SELECT turns FROM ctf.agent_sessions WHERE id=$1", [game.id])).rows[0]
          .turns,
        1,
        `${name}: the write committed`,
      );
      for (const line of logged) assert.ok(!line.includes(token), `${name}: no token in the log`);
    }
    assert.deepEqual(unexpected, [], "a remote address is never called");
  });

  await t.test(
    "W5: a dormant worker runs no query until a wake, then reviews and sleeps",
    async () => {
      await reset();
      let acquired = 0;
      pool.on("acquire", () => acquired++);
      const loops = createWorkerLoops({
        pass: () => runMonitorWorkerOnce(fastMonitorTiming),
        hasPending: hasPendingWork,
        clock: realClock,
        durations: {
          startWindowMs: 400,
          wakeLingerMs: 300,
          progressLimitMs: 1_500,
          safetyIntervalMs: 600_000,
          idlePollMs: 50,
        },
      });
      const endpoint = await startWakeEndpoint(loops.wake, loops.stop);
      const running = loops.run(4);
      try {
        await delay(1_000);
        const quiet = acquired;
        await delay(3_000);
        assert.equal(acquired, quiet, "a dormant worker acquires no connection for 3 seconds");

        const game = await seedGame();
        await saveMessage(game);
        await releaseSessionLease(game.id, game.id, game.lease);
        await until(
          async () =>
            (
              await pool.query(
                "SELECT 1 FROM ctf.monitor_reviews WHERE game_id=$1 AND verdict='allow'",
                [game.id],
              )
            ).rowCount === 1,
          "the review",
        );
        await until(async () => !(await hasPendingWork()), "the job to be covered");
        await delay(800);
        const settled = acquired;
        await delay(1_500);
        assert.equal(acquired, settled, "the worker is dormant again after the review");
      } finally {
        loops.stop();
        const results = await running;
        await endpoint.stop();
        assert.deepEqual(
          results.map((result) => result.status),
          Array(4).fill("fulfilled"),
        );
      }
    },
  );

  // Earlier scenarios leave reviews that reference their jobs, so these start from no runs at all.
  const resetRuns = async () => {
    await clearRow();
    await pool.query("TRUNCATE ctf.games CASCADE");
    logged.length = 0;
  };
  // A second session of a game, with its jobs given as [epoch, status, state] triples. A queued
  // job in the middle of its retries is `retrying`; a reviewing job's claim can be `expired`.
  const sessionWithJobs = async (
    gameId: string,
    ordinal: number,
    jobs: [number, string, ("retrying" | "expired")?][],
  ) => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO ctf.agent_sessions(id,game_id,ordinal,agent_model,agent_effort,system_prompt)
       VALUES($1,$2,$3,'synthetic-agent','medium','')`,
      [id, gameId, ordinal],
    );
    for (const [epoch, status, state] of jobs)
      await pool.query(
        `INSERT INTO ctf.monitor_jobs(id,game_id,session_id,epoch,start_version,requested_version,
           covered_version,attempts,status,claim_token,claim_until,next_attempt_at)
         VALUES($1,$2,$3,$4,1,1,CASE WHEN $5='queued' THEN 0 ELSE 1 END,2,$5,
           CASE WHEN $5='reviewing' THEN gen_random_uuid() END,
           CASE WHEN $5='reviewing' THEN now()+CASE WHEN $6='expired'
             THEN interval '-1 minute' ELSE interval '1 hour' END END,
           CASE WHEN $6='retrying' THEN now()+interval '1 hour' ELSE now() END)`,
        [randomUUID(), gameId, id, epoch, status, state ?? null],
      );
    return id;
  };
  const jobsBySession = async (gameId: string) =>
    (
      await pool.query(
        `SELECT session_id,epoch,status,attempts,(next_attempt_at<=now()) AS due
         FROM ctf.monitor_jobs WHERE game_id=$1 ORDER BY session_id,epoch`,
        [gameId],
      )
    ).rows.map((job) => ({ ...job, epoch: Number(job.epoch) }));

  await t.test(
    "B2-1: submission queues each session's newest final review and wakes the worker",
    async () => {
      await resetRuns();
      const target = await listen();
      const token = randomBytes(32).toString("hex");
      await setRow({ url: `http://127.0.0.1:${target.port}/wake`, instance: null, token });
      for (const http of [false, true]) {
        const game = await seedGame({ http });
        const mixed = await sessionWithJobs(game.id, 2, [
          [1, "caught-up"],
          [2, "caught-up"],
        ]);
        const caught = await sessionWithJobs(game.id, 3, [[1, "caught"]]);
        const reviewing = await sessionWithJobs(game.id, 4, [[1, "reviewing"]]);
        const unresolved = await sessionWithJobs(game.id, 5, [[1, "unresolved"]]);
        const retrying = await sessionWithJobs(game.id, 6, [[1, "queued", "retrying"]]);
        const expired = await sessionWithJobs(game.id, 7, [[1, "reviewing", "expired"]]);
        const submitter = http
          ? undefined
          : await pool.query(
              `INSERT INTO ctf.monitor_jobs(id,game_id,session_id,epoch,start_version,requested_version,
                 covered_version,attempts,status)
               VALUES($1,$2,$2,1,1,1,1,2,'caught-up')`,
              [randomUUID(), game.id],
            );
        const before = target.received.length;
        if (http) {
          const call = randomUUID();
          const dispatch = randomUUID();
          const submission = randomBytes(32).toString("base64url");
          const assistant = {
            role: "assistant",
            content: [
              { type: "toolCall", id: call, name: "sprite_exec", arguments: { command: "x" } },
            ],
            timestamp: 1,
          };
          await pool.query("UPDATE ctf.agent_sessions SET messages=$2 WHERE id=$1", [
            game.id,
            JSON.stringify([assistant]),
          ]);
          await pool.query(
            `INSERT INTO ctf.sprite_operations
             (id,sprite_name,game_id,session_id,tool_call_id,kind,command,execution_generation,
              submission_token_hash,originating_lease)
             VALUES($1,$2,$3,$3,$4,'command','x',0,$5,$6)`,
            [
              dispatch,
              `ctf-${game.id}`,
              game.id,
              call,
              hashSubmissionToken(submission),
              game.lease,
            ],
          );
          assert.equal(await receiveFlagSubmission({ token: submission, value: FLAG }), "accepted");
          await completeAsyncCommand({
            dispatchId: dispatch,
            gameId: game.id,
            sessionId: game.id,
            messages: [
              assistant,
              {
                role: "toolResult",
                toolCallId: call,
                toolName: "sprite_exec",
                content: [{ type: "text", text: "out" }],
                isError: false,
                timestamp: 2,
              },
            ] as never,
            outcome: "completed",
            output: "out",
          });
        } else {
          assert.ok(submitter);
          await beginAsyncSubmission({
            gameId: game.id,
            sessionId: game.id,
            lease: game.lease,
            value: "incorrect flag",
          });
        }
        assert.equal(
          (await pool.query("SELECT status FROM ctf.games WHERE id=$1", [game.id])).rows[0].status,
          "finalizing",
        );
        const jobs = await jobsBySession(game.id);
        const of = (session: string) => jobs.filter((job) => job.session_id === session);
        assert.deepEqual(
          of(mixed).map(({ epoch, status, attempts }) => [epoch, status, attempts]),
          [
            [1, "caught-up", 2],
            [2, "queued", 0],
          ],
          "only the newest epoch is queued, and an older one is left alone",
        );
        assert.equal(of(mixed)[1].due, true);
        assert.deepEqual(
          of(caught).map(({ status }) => status),
          ["caught"],
        );
        assert.deepEqual(
          of(reviewing).map(({ status }) => status),
          ["reviewing"],
        );
        for (const session of [unresolved, retrying])
          assert.deepEqual(
            of(session).map(({ status, attempts, due }) => [status, attempts, due]),
            [["queued", 0, true]],
            "an unresolved job and a job in its retries are due now",
          );
        assert.deepEqual(
          of(expired).map(({ status }) => status),
          ["reviewing"],
          "a claim that has expired is left for the next claim",
        );
        const claims = [];
        for (let claim = await claimMonitorJob(); claim; claim = await claimMonitorJob()) {
          claims.push(claim);
          await finishMonitorJob(claim, { kind: "allow" });
        }
        assert.equal(
          claims.find((claim) => claim.sessionId === expired)?.final,
          true,
          "the expired claim is reclaimed as a final claim",
        );
        if (!http)
          assert.deepEqual(
            of(game.id).map(({ status, attempts }) => [status, attempts]),
            [["queued", 0]],
          );
        await until(() => target.received.length > before, "a wake after the submission");
        assert.ok(await hasPendingWork());
      }
    },
  );

  await t.test(
    "B2-7: a worker idle past the wake linger claims a queued final review",
    async () => {
      await resetRuns();
      const loops = createWorkerLoops({
        pass: () => runMonitorWorkerOnce(fastMonitorTiming),
        hasPending: hasPendingWork,
        clock: realClock,
        durations: {
          startWindowMs: 400,
          wakeLingerMs: 300,
          progressLimitMs: 1_500,
          safetyIntervalMs: 600_000,
          idlePollMs: 50,
        },
      });
      const endpoint = await startWakeEndpoint(loops.wake, loops.stop);
      const running = loops.run(4);
      try {
        const game = await seedGame();
        await saveMessage(game);
        await releaseSessionLease(game.id, game.id, game.lease);
        const routes = async () =>
          (
            await pool.query(
              "SELECT route FROM ctf.monitor_reviews WHERE game_id=$1 AND completed_at IS NOT NULL ORDER BY created_at",
              [game.id],
            )
          ).rows.map(({ route }) => route);
        await until(async () => (await routes()).length === 1, "the first review");
        assert.deepEqual(await routes(), ["deferred"]);
        await until(async () => !(await hasPendingWork()), "the loops to go idle");
        await delay(1_000);
        await pool.query(
          "UPDATE ctf.agent_sessions SET lease=$2,lease_until=now()+interval '1 minute' WHERE id=$1",
          [game.id, game.lease],
        );
        await beginAsyncSubmission({
          gameId: game.id,
          sessionId: game.id,
          lease: game.lease,
          value: "incorrect flag",
        });
        assert.ok(await hasPendingWork(), "the queued final review is pending work");
        await releaseSessionLease(game.id, game.id, game.lease);
        await until(
          async () =>
            (await pool.query("SELECT status FROM ctf.games WHERE id=$1", [game.id])).rows[0]
              .status === "ended",
          "the run to finalize",
        );
        assert.deepEqual(await routes(), ["deferred", "final"]);
        const [job] = (
          await pool.query(
            "SELECT final_version,requested_version FROM ctf.monitor_jobs WHERE game_id=$1",
            [game.id],
          )
        ).rows;
        assert.equal(Number(job.final_version), Number(job.requested_version));
      } finally {
        loops.stop();
        const results = await running;
        await endpoint.stop();
        assert.deepEqual(
          results.map((result) => result.status),
          Array(4).fill("fulfilled"),
        );
      }
    },
  );

  await t.test(
    "a run already finalizing with a caught-up job and no final allow reaches its final review",
    async () => {
      await resetRuns();
      const game = await seedGame();
      await saveMessage(game);
      await releaseSessionLease(game.id, game.id, game.lease);
      assert.equal(await runMonitorWorkerOnce(fastMonitorTiming), true);
      // The state an older worker leaves: submitted, every job caught up, nothing queued.
      await pool.query(
        `UPDATE ctf.games SET status='finalizing',submitted_flag_correct=false,
         submitted_session_id=$1 WHERE id=$1`,
        [game.id],
      );
      await pool.query("INSERT INTO ctf.finalization_jobs(game_id) VALUES($1)", [game.id]);
      const jobs = () =>
        pool.query(
          "SELECT status,final_version,requested_version FROM ctf.monitor_jobs WHERE game_id=$1",
          [game.id],
        );
      const [before] = (await jobs()).rows;
      assert.deepEqual([before.status, Number(before.final_version)], ["caught-up", 0]);
      assert.ok(await hasPendingWork(), "an idle worker finds the run");
      for (let pass = 0; pass < 6; pass++) {
        await runMonitorWorkerOnce(fastMonitorTiming);
        const status = (await pool.query("SELECT status FROM ctf.games WHERE id=$1", [game.id]))
          .rows[0].status;
        if (status !== "finalizing") break;
      }
      assert.equal(
        (await pool.query("SELECT status FROM ctf.games WHERE id=$1", [game.id])).rows[0].status,
        "ended",
      );
      const [after] = (await jobs()).rows;
      assert.equal(Number(after.final_version), Number(after.requested_version));
    },
  );

  await t.test(
    "W7: the worker script exits cleanly on SIGTERM and non-zero on a failed pass",
    async () => {
      const run = async (database: string, jumpMs: number) => {
        const child = spawn(
          process.execPath,
          [
            "--import",
            "tsx",
            "--import",
            "./tests/integration/idle-worker-preload.ts",
            "scripts/monitor-worker.ts",
          ],
          {
            cwd: process.cwd(),
            env: {
              PATH: process.env.PATH ?? "",
              HOME: process.env.HOME ?? "",
              NODE_ENV: "test",
              CTF_INTEGRATION_DATABASE_URL: urlFor(database).toString(),
              IDLE_WORKER_JUMP_MS: String(jumpMs),
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        t.after(() => {
          if (child.exitCode === null) child.kill("SIGKILL");
        });
        let output = "";
        child.stdout.on("data", (chunk) => (output += String(chunk)));
        child.stderr.on("data", (chunk) => (output += String(chunk)));
        return { child, exited: once(child, "exit"), output: () => output };
      };

      // A database with the settings table and nothing else: every pass fails.
      const bareAdmin = new Pool({ connectionString: urlFor(bare).toString(), max: 1 });
      await bareAdmin.query("CREATE SCHEMA ctf");
      await bareAdmin.query(await sql("migrations/017-settings.sql"));
      await bareAdmin.end();
      const failing = await run(bare, 60_000);
      const [failedCode] = await failing.exited;
      assert.notEqual(failedCode, 0, failing.output());
      assert.match(failing.output(), /monitor\.worker\.failed/);

      const fullPool = new Pool({ connectionString: urlFor(full).toString(), max: 1 });
      await migrateFreshDatabase(fullPool);
      await fullPool.query(await sql("migrations/017-settings.sql"));
      const healthy = await run(full, 500);
      const registered = async () =>
        (await fullPool.query("SELECT 1 FROM ctf.settings WHERE key=$1", [WAKE_KEY])).rowCount ===
        1;
      await until(registered, "the worker's registration", 30_000);
      // Past the jump the start window is over and nothing is pending, so every loop waits.
      await delay(2_500);
      assert.equal(healthy.child.exitCode, null, healthy.output());
      const signalled = Date.now();
      healthy.child.kill("SIGTERM");
      const [code] = await healthy.exited;
      assert.equal(code, 0, healthy.output());
      assert.ok(Date.now() - signalled < 3_000, "a dormant worker stops at once");
      assert.equal(await registered(), false, "a clean exit removes the registration");
      await closePool(fullPool);
    },
  );
});
