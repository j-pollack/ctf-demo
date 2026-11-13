import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { Pool } from "pg";
import { SpritesClient } from "@fly/sprites";
import { flagReadCases } from "../../scripts/flag-read-cases";
import { seedCase } from "../../scripts/flag-read-eval-live";
import { migrateFreshDatabase } from "../../scripts/monitor-investigate-eval-live";
import { resolveFlagReadPolicy } from "../../lib/flag-read-policy";
import { closePool } from "./postgres";
import { fastMonitorTiming, fastMonitorDelays } from "./monitor-timing";

const base = new URL(process.env.CTF_INTEGRATION_DATABASE_URL ?? "http://missing");
assert.equal(process.env.NODE_ENV, "test");
assert.equal(base.hostname, "127.0.0.1");
assert.match(base.pathname, /^\/ctf_integration_[a-f0-9]{32}$/);
const productionVersion = "investigator-v14-glm53-jev114-presumption-digitalocean";
const modes = [
  "allow",
  "block",
  "legacy",
  "legacy-context",
  "unknown-version",
  "unavailable",
  "overrun",
  "slow-success",
  "deadline",
  "classifier-timeout",
] as const;

await test(
  "production worker preserves policy attribution and bounded accounting",
  { timeout: 360_000 },
  async (t) => {
    const mode = process.env.CTF_PRODUCTION_TEST_MODE;
    const realTiming = process.env.CTF_REAL_MONITOR_TIMING === "1";
    if (!mode) {
      for (const value of realTiming ? ["deadline"] : modes)
        await t.test(value, () => {
          const result = spawnSync(
            process.execPath,
            ["--import", "tsx", "--test", fileURLToPath(import.meta.url)],
            {
              env: {
                ...process.env,
                NODE_TEST_CONTEXT: undefined,
                CTF_PRODUCTION_TEST_MODE: value,
              },
              encoding: "utf8",
              timeout: 120_000,
            },
          );
          assert.match(result.stdout, /tests [1-9]/);
          assert.equal(result.status, 0, result.stdout + result.stderr);
        });
      return;
    }
    assert.ok(modes.some((value) => value === mode));
    const timed = ["slow-success", "deadline", "classifier-timeout"].includes(mode);
    const timing = timed && !realTiming ? fastMonitorTiming : undefined;
    const database = `ctf_integration_${randomUUID().replaceAll("-", "")}`;
    const adminUrl = new URL(base);
    adminUrl.pathname = "/postgres";
    const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
    await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(base);
    url.pathname = `/${database}`;
    const pool = new Pool({
      connectionString: url.toString(),
      options: "-c search_path=ctf,public",
      max: 5,
    });
    (globalThis as typeof globalThis & { ctfPool?: Pool }).ctfPool = pool;
    t.after(async () => {
      await closePool(pool);
      await admin.query(`DROP DATABASE "${database}"`);
      await admin.end();
      delete (globalThis as typeof globalThis & { ctfPool?: Pool }).ctfPool;
    });
    await migrateFreshDatabase(pool);
    const legacy = mode === "legacy" || mode === "legacy-context";
    const policy = resolveFlagReadPolicy(legacy ? "current" : undefined);
    const version =
      mode === "unknown-version"
        ? "unsupported-policy-version"
        : mode === "legacy-context"
          ? "investigator-v8-glm53-jev114-context32k"
          : legacy
            ? policy.monitorVersion
            : productionVersion;
    const item = flagReadCases[0];
    const workspace = await seedCase(
      pool,
      item,
      2_000_000,
      "deepseek/deepseek-v4.1-flash-1017",
      "jev-1.14.0",
      version,
    );
    const sessionId = workspace.sessionIds.get(item.targetSessionId)!;
    const { enqueueMonitorJob } = await import("../../lib/monitor-jobs");
    const {
      rows: [head],
    } = await pool.query(
      "SELECT epoch,version FROM ctf.transcript_observations WHERE session_id=$1 ORDER BY version DESC LIMIT 1",
      [sessionId],
    );
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await enqueueMonitorJob(client, {
        gameId: workspace.gameId,
        sessionId,
        epoch: Number(head.epoch),
        version: Number(head.version),
      });
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const failures: unknown[] = [];
    let classifier = 0,
      investigator = 0,
      deleted = 0;
    const oldKey = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = "integration-typesafe-key";
    t.after(() => {
      if (oldKey === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = oldKey;
    });
    t.mock.method(SpritesClient.prototype, "deleteSprite", async (name: string) => {
      assert.equal(mode, "block");
      const {
        rows: [game],
      } = await pool.query("SELECT sprite_name,status FROM ctf.games WHERE id=$1", [
        workspace.gameId,
      ]);
      assert.equal(name, game.sprite_name);
      assert.equal(game.status, "caught");
      deleted++;
    });
    t.mock.method(
      globalThis,
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        try {
          const endpoint = String(input);
          if (endpoint === "https://openrouter.ai/api/v1/models")
            return Response.json({
              data: [
                {
                  id: "z-ai/glm-5.3",
                  context_length: 200_000,
                  pricing: { prompt: "0.000001", completion: "0.000002" },
                  supported_parameters: ["tools", "reasoning"],
                },
              ],
            });
          assert.equal(init?.method, "POST");
          const body = JSON.parse(String(init.body));
          if (endpoint === "https://api.typesafe.ai/v1/systemone") {
            classifier++;
            assert.deepEqual(Object.keys(body.questions).sort(), ["intent", "suspicion"]);
            const {
              rows: [claim],
            } = await pool.query(
              "SELECT extract(epoch FROM (claim_until-updated_at))*1000 AS duration FROM ctf.monitor_jobs WHERE game_id=$1 AND status='reviewing'",
              [workspace.gameId],
            );
            assert.equal(Number(claim.duration), 120_000);
            const { rows: holds } = await pool.query(
              "SELECT cost_ceiling FROM ctf.inference WHERE model='jev-1.14.0' AND settled_at IS NULL",
            );
            assert.equal(holds.length, legacy ? 0 : 1);
            if (!legacy) assert.ok(Number(holds[0].cost_ceiling) > 0);
            if (mode === "classifier-timeout")
              await delay(fastMonitorDelays.classifierMs, undefined, { signal: init.signal! });
            return Response.json({
              answers: {
                intent: { type: "noul", noul: 0 },
                suspicion: { type: "score", score: 0, confidence: 1 },
              },
              usage: { input_tokens: 100 },
            });
          }
          assert.equal(endpoint, "https://openrouter.ai/api/v1/chat/completions");
          investigator++;
          assert.equal(body.messages[0].content, policy.systemPrompt);
          assert.equal(body.reasoning.effort, "high");
          assert.deepEqual(
            body.provider,
            legacy
              ? { require_parameters: true }
              : {
                  require_parameters: true,
                  only: ["digitalocean"],
                  allow_fallbacks: false,
                  max_price: { prompt: 0.91, completion: 2.86, request: 0 },
                },
          );
          const {
            rows: [reservation],
          } = await pool.query(
            "SELECT cost_ceiling::int AS cost,token_ceiling FROM ctf.inference WHERE model='z-ai/glm-5.3' AND settled_at IS NULL",
          );
          assert.equal(
            reservation.cost,
            Math.ceil((reservation.token_ceiling - body.max_tokens) * (legacy ? 1 : 0.91) * 2) +
              Math.ceil(body.max_tokens * (legacy ? 2 : 2.86)),
          );
          if (mode === "unavailable")
            return Response.json(
              { error: { message: "No eligible DigitalOcean endpoint", code: 404 } },
              { status: 404 },
            );
          if (mode === "slow-success" || mode === "deadline")
            await delay(
              realTiming
                ? 95_000
                : mode === "slow-success"
                  ? fastMonitorDelays.successMs
                  : fastMonitorDelays.investigatorMs,
              undefined,
              {
                signal: init.signal!,
              },
            );
          const prompt = String(body.messages.at(-1).content);
          const evidence = JSON.parse(prompt.slice(prompt.indexOf("\n\n") + 2));
          const ref = evidence.snapshot.currentTranscript.find(
            (row: { role: string }) => row.role === "tool",
          )?.ref;
          if (mode === "block") assert.ok(ref);
          const next =
            mode === "overrun"
              ? {
                  name: "query_transcripts",
                  arguments: JSON.stringify({ sql: "SELECT count(*) FROM sessions" }),
                }
              : {
                  name: "finish_investigation",
                  arguments: JSON.stringify({
                    flagReadDetected: mode === "block",
                    reason: mode === "block" ? "Observed target read." : "No evidenced read.",
                    evidence: mode === "block" ? [{ ref }] : [],
                  }),
                };
          return Response.json({
            id: `synthetic-${randomUUID()}`,
            choices: [
              {
                message: {
                  role: "assistant",
                  tool_calls: [{ id: randomUUID(), type: "function", function: next }],
                },
                finish_reason: "tool_calls",
              },
            ],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 30,
              total_tokens: 130,
              cost: mode === "overrun" ? 1 : 0.00001,
            },
          });
        } catch (error) {
          if (
            !(
              error instanceof Error &&
              error.name === "AbortError" &&
              ["deadline", "classifier-timeout"].includes(mode)
            )
          )
            failures.push(error);
          throw error;
        }
      },
    );
    const { runMonitorWorkerOnce } = await import("../../lib/monitor-worker");
    const started = Date.now();
    assert.equal(await runMonitorWorkerOnce(timing), true);
    const elapsed = Date.now() - started;
    assert.deepEqual(failures, []);
    const {
      rows: [job],
    } = await pool.query(
      "SELECT status,covered_version,reason FROM ctf.monitor_jobs WHERE game_id=$1",
      [workspace.gameId],
    );
    const { rows: reviews } = await pool.query(
      "SELECT prompt_version FROM ctf.monitor_reviews WHERE game_id=$1",
      [workspace.gameId],
    );
    if (mode === "unknown-version") {
      assert.equal(classifier + investigator, 0);
      assert.equal(reviews.length, 0);
      assert.equal(job.status, "queued");
      assert.match(job.reason, /version/i);
      return;
    }
    assert.deepEqual(reviews, [{ prompt_version: version }]);
    assert.equal(classifier, 1);
    assert.equal(
      investigator,
      mode === "classifier-timeout" ? 0 : 1,
      "single transport attempt; no fallback or retry inside a review",
    );
    const success = ["allow", "block", "legacy", "legacy-context", "slow-success"].includes(mode);
    assert.equal(job.status, success ? (mode === "block" ? "caught" : "caught-up") : "queued");
    assert.equal(
      Number(job.covered_version),
      success && mode !== "block" ? Number(head.version) : 0,
    );
    const {
      rows: [game],
    } = await pool.query(
      "SELECT status,monitor_version,spent_microdollars::int AS spent,reserved_microdollars::int AS held FROM ctf.games WHERE id=$1",
      [workspace.gameId],
    );
    assert.equal(game.monitor_version, version);
    assert.equal(game.status, mode === "block" ? "caught" : "active");
    assert.equal(deleted, 0, "a single-session caught run remains forkable");
    assert.equal(
      game.spent,
      mode === "overrun"
        ? 1_000_004
        : mode === "classifier-timeout"
          ? 0
          : ["deadline", "unavailable"].includes(mode)
            ? 4
            : 14,
    );
    const {
      rows: [accounting],
    } = await pool.query(
      "SELECT coalesce(sum(cost) FILTER(WHERE settled_at IS NOT NULL),0)::int AS spent,coalesce(sum(cost_ceiling) FILTER(WHERE settled_at IS NULL),0)::int AS held FROM ctf.inference",
    );
    if (!legacy) assert.deepEqual(accounting, { spent: game.spent, held: game.held });
    if (["deadline", "classifier-timeout"].includes(mode)) assert.ok(game.held > 0);
    else assert.equal(game.held, 0);
    if (mode === "overrun") assert.match(job.reason, /reserved|allowance/i);
    const expectedMs =
      mode === "slow-success"
        ? fastMonitorDelays.successMs
        : mode === "deadline"
          ? realTiming
            ? 90_000
            : fastMonitorTiming.deadlineMs
          : mode === "classifier-timeout"
            ? fastMonitorTiming.classifierDeadlineMs
            : undefined;
    if (expectedMs)
      assert.ok(
        elapsed >= expectedMs - (realTiming ? 500 : 50) &&
          elapsed < expectedMs + (realTiming ? 10_000 : 3_000),
        `elapsed ${elapsed}ms`,
      );
  },
);
