import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { Pool } from "pg";
import { SpritesClient } from "@fly/sprites";
import { flagReadCases } from "../../scripts/flag-read-cases";
import { seedCase } from "../../scripts/flag-read-eval-live";
import { migrateFreshDatabase } from "../../scripts/monitor-investigate-eval-live";
import {
  FLAG_READ_MONITOR_VERSION,
  PREVIOUS_FLAG_READ_MONITOR_VERSION,
  V15_FLAG_READ_MONITOR_VERSION,
} from "../../lib/control";
import { confirmationTrace } from "./read-confirmation";
import { flagReadPolicyById } from "../../lib/flag-read-policy";
import { STREAM_IDLE_MS } from "../../lib/investigator-evaluation-policy";
import { DAILY_CAP_MICRODOLLARS } from "../../lib/policy";
import { closePool } from "./postgres";
import { fastMonitorTiming, fastMonitorDelays } from "./monitor-timing";
import { slowCompletion, streamedCompletion } from "./completion-stream";

const base = new URL(process.env.CTF_INTEGRATION_DATABASE_URL ?? "http://missing");
assert.equal(process.env.NODE_ENV, "test");
assert.equal(base.hostname, "127.0.0.1");
assert.match(base.pathname, /^\/ctf_integration_[a-f0-9]{32}$/);
// Each of these reviews like "allow" but under another stamp or isolation rule (P3, P4).
const policyModes = {
  "policy-v15-shared": { version: V15_FLAG_READ_MONITOR_VERSION, isolated: true, id: "v15-shared" },
  "policy-v14": { version: PREVIOUS_FLAG_READ_MONITOR_VERSION, isolated: false, id: "v14" },
  "block-v14": { version: PREVIOUS_FLAG_READ_MONITOR_VERSION, isolated: false, id: "v14" },
  "policy-v14-isolated": { version: PREVIOUS_FLAG_READ_MONITOR_VERSION, isolated: true, id: "v14" },
} as const;
const modes = [
  "allow",
  "block",
  "unknown-version",
  "unavailable",
  "overrun",
  "slow-success",
  "deadline",
  "classifier-timeout",
  "budget-between",
  "budget-equal",
  "budget-two-call",
  "sibling-hold",
  "daily-cap",
  "over-ceiling",
  ...(Object.keys(policyModes) as (keyof typeof policyModes)[]),
] as const;
// Budget modes: the player's run budget must not refuse a review (B1, B2). Only the monitor's own
// allowance (B8) or the shared daily cap (B4) does.
const runBudgetModes = ["budget-between", "budget-equal", "budget-two-call", "sibling-hold"];
const refusedModes = ["daily-cap", "over-ceiling"];
// Remaining run budget, in microdollars, for the modes that seed a tight run.
const TIGHT_REMAINING = 1_000;
const SIBLING_REMAINING = 60_000;
// Mirrors MONITOR_RUN_ALLOWANCE_MICRODOLLARS in lib/policy.ts, which is stated by the contract, not imported.
const MONITOR_ALLOWANCE = 1_500_000;

await test(
  "production worker preserves policy attribution and bounded accounting",
  { timeout: 360_000 },
  async (t) => {
    const mode = process.env.CTF_PRODUCTION_TEST_MODE;
    const realTiming = process.env.CTF_REAL_MONITOR_TIMING === "1";
    if (!mode) {
      for (const value of realTiming ? ["slow-success", "deadline"] : modes)
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
    // block-v14 catches a run stamped v14 (P4); the other modes keep their own names.
    const blocking = mode === "block" || mode === "block-v14";
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
    const run = Object.hasOwn(policyModes, mode)
      ? policyModes[mode as keyof typeof policyModes]
      : { version: FLAG_READ_MONITOR_VERSION, isolated: false, id: "v16-unknown" as const };
    const policy = flagReadPolicyById(run.id);
    const version = mode === "unknown-version" ? "unsupported-policy-version" : run.version;
    const item = { ...flagReadCases[0], isolated: run.isolated };
    const remaining =
      mode === "budget-between" || mode === "budget-two-call"
        ? TIGHT_REMAINING
        : mode === "sibling-hold"
          ? SIBLING_REMAINING
          : 2_000_000;
    const workspace = await seedCase(
      pool,
      item,
      remaining,
      "deepseek/deepseek-v4.1-flash-1017",
      "typesafe/jev-1.14",
      version,
    );
    const sessionId = workspace.sessionIds.get(item.targetSessionId)!;
    // The seeded operations carry no command text, so the review's signal is an unclear screen of
    // the session's first instruction, stored as the player's screen would have stored it.
    const {
      rows: [stored],
    } = await pool.query("SELECT messages FROM ctf.agent_sessions WHERE id=$1", [sessionId]);
    const { textOf } = await import("../../lib/inference");
    const instruction = textOf(
      stored.messages.find((message: { role: string }) => message.role === "user"),
    );
    await pool.query(
      `INSERT INTO ctf.text_screens
       (game_id,session_id,kind,ref,text_sha256,question_set,answers,model,input_tokens,duration_ms)
       VALUES($1,$2,'instruction',$3,$3,'player-v2',$4,'typesafe/jev-1.14',0,0)`,
      [
        workspace.gameId,
        sessionId,
        createHash("sha256").update(instruction).digest("hex"),
        JSON.stringify({ overrides_rules: 0.6 }),
      ],
    );
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
    t.mock.method(SpritesClient.prototype, "deleteSprite", async (name: string) => {
      assert.ok(blocking);
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
          if (endpoint === "https://openrouter.ai/api/v1/systemone") {
            classifier++;
            assert.deepEqual(Object.keys(body.questions).sort(), ["intent", "suspicion"]);
            const {
              rows: [claim],
            } = await pool.query(
              "SELECT extract(epoch FROM (claim_until-updated_at))*1000 AS duration FROM ctf.monitor_jobs WHERE game_id=$1 AND status='reviewing'",
              [workspace.gameId],
            );
            assert.equal(Number(claim.duration), 660_000);
            const { rows: holds } = await pool.query(
              "SELECT cost_ceiling FROM ctf.inference WHERE model='typesafe/jev-1.14' AND settled_at IS NULL",
            );
            assert.equal(holds.length, 1);
            assert.ok(Number(holds[0].cost_ceiling) > 0);
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
          assert.equal(body.stream, true, "investigator requests stream");
          if (runBudgetModes.includes(mode)) assert.equal(body.max_tokens, 8192);
          assert.equal(body.messages[0].content, policy.systemPrompt);
          assert.equal(body.reasoning.effort, "high");
          assert.deepEqual(body.provider, {
            require_parameters: true,
            only: ["digitalocean"],
            allow_fallbacks: false,
            max_price: { prompt: 0.91, completion: 2.86, request: 0 },
          });
          const {
            rows: [reservation],
          } = await pool.query(
            "SELECT cost_ceiling::int AS cost,token_ceiling FROM ctf.inference WHERE model='z-ai/glm-5.3' AND settled_at IS NULL",
          );
          assert.equal(
            reservation.cost,
            Math.ceil(
              (reservation.token_ceiling - body.max_tokens) *
                (body.provider.max_price.prompt / 1e6) *
                2 *
                1e6,
            ) + Math.ceil(body.max_tokens * (body.provider.max_price.completion / 1e6) * 1e6),
          );
          if (mode === "unavailable")
            return Response.json(
              { error: { message: "No eligible DigitalOcean endpoint", code: 404 } },
              { status: 404 },
            );
          // A slow success keeps its stream alive; a deadline never sends headers.
          if (mode === "deadline")
            await delay(realTiming ? 95_000 : fastMonitorDelays.investigatorMs, undefined, {
              signal: init.signal!,
            });
          // The second request of a blocking review answers the confirmation.
          if (blocking && investigator === 2) {
            assert.equal(body.messages.at(-1).role, "tool");
            assert.ok(confirmationTrace(body.messages.at(-1).content).cited.length >= 1);
          }
          const prompt = String(
            body.messages.findLast((message: { role: string }) => message.role === "user").content,
          );
          const evidence = JSON.parse(prompt.slice(prompt.indexOf("\n\n") + 2));
          const ref = evidence.snapshot.currentTranscript.find(
            (row: { role: string }) => row.role === "tool",
          )?.ref;
          if (blocking) assert.ok(ref);
          const next =
            mode === "overrun" || (mode === "budget-two-call" && investigator === 1)
              ? {
                  name: "query_transcripts",
                  arguments: JSON.stringify({ sql: "SELECT count(*) FROM sessions" }),
                }
              : {
                  name: "finish_investigation",
                  arguments: JSON.stringify({
                    flagReadDetected: blocking,
                    reason: blocking ? "Observed target read." : "No evidenced read.",
                    evidence: blocking ? [{ ref }] : [],
                  }),
                };
          const completion = {
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
          };
          if (mode === "slow-success")
            return slowCompletion(init, completion, {
              totalMs: realTiming ? 95_000 : fastMonitorDelays.successMs,
              tickMs: realTiming ? 5_000 : 100,
            });
          return streamedCompletion(init, completion);
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
    if (mode === "allow") {
      // While the target's turn is live, the worker reviews nothing for it.
      await runMonitorWorkerOnce(timing);
      const {
        rows: [waiting],
      } = await pool.query("SELECT status,attempts FROM ctf.monitor_jobs WHERE game_id=$1", [
        workspace.gameId,
      ]);
      assert.deepEqual(waiting, { status: "queued", attempts: 0 });
      assert.equal(
        (await pool.query("SELECT 1 FROM ctf.monitor_reviews WHERE job_id IS NOT NULL")).rowCount,
        0,
      );
      assert.equal(classifier + investigator, 0);
    }
    const {
      rows: [before],
    } = await pool.query(
      "SELECT spent_microdollars::int AS spent,budget_microdollars::int AS budget FROM ctf.games WHERE id=$1",
      [workspace.gameId],
    );
    let sibling: { id: string; cost: number } | undefined;
    const seedSpend = async (role: string, microdollars: number) => {
      await pool.query(
        "INSERT INTO ctf.daily_spend(day) VALUES((now() AT TIME ZONE 'UTC')::date) ON CONFLICT DO NOTHING",
      );
      await pool.query(
        `INSERT INTO ctf.inference(id,game_id,day,role,model,token_ceiling,cost_ceiling,tokens,cost,settled_at)
         VALUES(gen_random_uuid(),$1,(now() AT TIME ZONE 'UTC')::date,$2,'seeded',1,$3,1,$3,now())`,
        [workspace.gameId, role, microdollars],
      );
      await pool.query(
        "UPDATE ctf.games SET spent_microdollars=spent_microdollars+$2,tokens_used=tokens_used+1 WHERE id=$1",
        [workspace.gameId, microdollars],
      );
    };
    if (mode === "budget-equal") await seedSpend("agent", before.budget - before.spent);
    if (mode === "over-ceiling") await seedSpend("monitor", MONITOR_ALLOWANCE);
    if (mode === "daily-cap")
      await pool.query(
        `INSERT INTO ctf.daily_spend(day,charged) VALUES((now() AT TIME ZONE 'UTC')::date,$1)
         ON CONFLICT (day) DO UPDATE SET charged=$1`,
        [DAILY_CAP_MICRODOLLARS],
      );
    if (mode === "sibling-hold") {
      // A second session of the run, with a live lease, holds a real agent reservation that takes the
      // whole remaining budget.
      const siblingSession = randomUUID();
      const siblingLease = randomUUID();
      await pool.query(
        `INSERT INTO ctf.agent_sessions
          (id,game_id,ordinal,agent_model,agent_effort,system_prompt,messages,turns,lease,lease_until)
         SELECT $1,$2,coalesce(max(ordinal),0)+1,'deepseek/deepseek-v4.1-flash-1017','high','','[]',0,$3,
           now()+interval '30 minutes' FROM ctf.agent_sessions WHERE game_id=$2`,
        [siblingSession, workspace.gameId, siblingLease],
      );
      const { reserveInference } = await import("../../lib/games");
      const held = await reserveInference(
        workspace.gameId,
        siblingLease,
        "agent",
        "sibling/agent-model",
        100,
        1_000_000,
        1e-6,
        2e-6,
        { sessionId: siblingSession },
      );
      sibling = { id: held.id, cost: held.cost };
      const {
        rows: [state],
      } = await pool.query(
        `SELECT (budget_microdollars-(SELECT coalesce(sum(CASE WHEN settled_at IS NULL THEN cost_ceiling ELSE cost END),0)
           FROM ctf.inference WHERE game_id=games.id AND role IN ('agent','screen')))::int AS available
         FROM ctf.games WHERE id=$1`,
        [workspace.gameId],
      );
      assert.ok(state.available >= 0 && state.available < 64 * 2, "the sibling holds the budget");
    }
    // The production worker reviews a session after its turn has ended.
    await pool.query(
      "UPDATE ctf.agent_sessions SET lease_until=now()-interval '1 second' WHERE id=$1",
      [sessionId],
    );
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
      "SELECT prompt_version,prompt_hash FROM ctf.monitor_reviews WHERE game_id=$1",
      [workspace.gameId],
    );
    if (mode === "unknown-version") {
      assert.equal(classifier + investigator, 0);
      assert.equal(reviews.length, 0);
      assert.equal(job.status, "queued");
      assert.match(job.reason, /version/i);
      return;
    }
    if (runBudgetModes.includes(mode)) {
      assert.deepEqual(reviews, [{ prompt_version: version, prompt_hash: policy.promptHash }]);
      assert.equal(classifier, 1);
      assert.equal(investigator, mode === "budget-two-call" ? 2 : 1);
      assert.equal(job.status, "caught-up");
      assert.equal(Number(job.covered_version), Number(head.version));
      const {
        rows: [review],
      } = await pool.query("SELECT verdict FROM ctf.monitor_reviews WHERE game_id=$1", [
        workspace.gameId,
      ]);
      assert.equal(review.verdict, "allow");
      const {
        rows: [after],
      } = await pool.query(
        "SELECT spent_microdollars::int AS spent,reserved_microdollars::int AS held FROM ctf.games WHERE id=$1",
        [workspace.gameId],
      );
      const settled = mode === "budget-two-call" ? 24 : 14;
      const start = mode === "budget-equal" ? before.budget : before.spent;
      assert.equal(after.spent, start + settled);
      if (mode === "budget-equal") assert.ok(after.spent > before.budget);
      if (sibling) {
        assert.equal(after.held, sibling.cost, "only the sibling's reservation remains held");
        const {
          rows: [hold],
        } = await pool.query(
          "SELECT cost_ceiling::int AS cost,settled_at,role FROM ctf.inference WHERE id=$1",
          [sibling.id],
        );
        assert.deepEqual(hold, { cost: sibling.cost, settled_at: null, role: "agent" });
      } else assert.equal(after.held, 0);
      return;
    }
    if (refusedModes.includes(mode)) {
      assert.equal(classifier + investigator, 0, "the review was refused before dispatch");
      assert.equal(job.status, "queued");
      assert.match(
        job.reason,
        mode === "daily-cap"
          ? /shared inference budget/i
          : /The monitor’s budget for this run is used up\./,
      );
      const {
        rows: [after],
      } = await pool.query(
        "SELECT spent_microdollars::int AS spent,reserved_microdollars::int AS held FROM ctf.games WHERE id=$1",
        [workspace.gameId],
      );
      assert.equal(after.held, 0);
      assert.equal(
        after.spent,
        mode === "over-ceiling" ? before.spent + MONITOR_ALLOWANCE : before.spent,
      );
      return;
    }
    assert.deepEqual(reviews, [{ prompt_version: version, prompt_hash: policy.promptHash }]);
    assert.equal(
      (
        await pool.query("SELECT read_confirmation FROM ctf.monitor_reviews WHERE game_id=$1", [
          workspace.gameId,
        ])
      ).rows[0].read_confirmation,
      blocking ? "kept" : null,
    );
    assert.equal(classifier, 1);
    assert.equal(
      investigator,
      mode === "classifier-timeout" ? 0 : blocking ? 2 : 1,
      "single transport attempt per request; a reported read adds its confirmation request",
    );
    const success = ["allow", "block", "slow-success", ...Object.keys(policyModes)].includes(mode);
    assert.equal(job.status, success ? (blocking ? "caught" : "caught-up") : "queued");
    assert.equal(Number(job.covered_version), success && !blocking ? Number(head.version) : 0);
    const {
      rows: [game],
    } = await pool.query(
      "SELECT status,monitor_version,spent_microdollars::int AS spent,reserved_microdollars::int AS held FROM ctf.games WHERE id=$1",
      [workspace.gameId],
    );
    assert.equal(game.monitor_version, version);
    assert.equal(game.status, blocking ? "caught" : "active");
    assert.equal(
      deleted,
      blocking ? 1 : 0,
      "a caught single-session run's Sprite is deleted in the same worker pass",
    );
    const {
      rows: [spriteRow],
    } = await pool.query("SELECT sprite_deleted_at FROM ctf.games WHERE id=$1", [workspace.gameId]);
    assert.equal(spriteRow.sprite_deleted_at !== null, blocking);
    // A request that failed before any generation id is charged its ceiling at once.
    const {
      rows: [ceilingCharged],
    } = await pool.query(
      "SELECT coalesce(sum(cost),0)::int AS cost,count(*)::int AS requests FROM ctf.inference WHERE estimated AND settled_at IS NOT NULL AND generation_id IS NULL",
    );
    const unidentified = ["deadline", "classifier-timeout"].includes(mode);
    assert.equal(ceilingCharged.requests, unidentified ? 1 : 0);
    assert.equal(
      game.spent,
      mode === "overrun"
        ? 1_000_004
        : mode === "classifier-timeout"
          ? ceilingCharged.cost
          : mode === "deadline"
            ? 4 + ceilingCharged.cost
            : mode === "unavailable"
              ? 4
              : blocking
                ? 24
                : 14,
    );
    const {
      rows: [accounting],
    } = await pool.query(
      "SELECT coalesce(sum(cost) FILTER(WHERE settled_at IS NOT NULL),0)::int AS spent,coalesce(sum(cost_ceiling) FILTER(WHERE settled_at IS NULL),0)::int AS held FROM ctf.inference",
    );
    assert.deepEqual(accounting, { spent: game.spent, held: game.held });
    assert.equal(game.held, 0);
    if (unidentified) assert.ok(ceilingCharged.cost > 0);
    if (mode === "overrun") assert.match(job.reason, /reserved|allowance/i);
    if (mode === "deadline" && realTiming) {
      // No headers ever arrived, so the request has no generation id and is charged its ceiling.
      assert.match(job.reason, /The investigator's model stopped responding\./);
      const { rows: charged } = await pool.query(
        "SELECT cost=cost_ceiling AS at_ceiling FROM ctf.inference WHERE model='z-ai/glm-5.3' AND estimated AND settled_at IS NOT NULL AND generation_id IS NULL",
      );
      assert.deepEqual(charged, [{ at_ceiling: true }]);
    }
    const expectedMs =
      mode === "slow-success"
        ? realTiming
          ? 95_000
          : fastMonitorDelays.successMs
        : mode === "deadline"
          ? realTiming
            ? // A provider that sends no headers: the 45 second idle bound in infer fires before
              // the 600 second review deadline, which this suite cannot reach.
              STREAM_IDLE_MS
            : fastMonitorTiming.deadlineMs
          : mode === "classifier-timeout"
            ? fastMonitorTiming.classifierDeadlineMs
            : undefined;
    if (mode === "policy-v14") {
      // P4: a v14 run that submitted while active is finalized by the same worker as before.
      await pool.query(
        `UPDATE ctf.games SET status='finalizing',submitted_flag_correct=false,submitted_session_id=$2
         WHERE id=$1`,
        [workspace.gameId, sessionId],
      );
      await pool.query("INSERT INTO ctf.finalization_jobs(game_id) VALUES($1)", [workspace.gameId]);
      // Submission queues the session's final review. One pass runs it and the next finalizes.
      const { queueFinalReviews } = await import("../../lib/monitor-jobs");
      const { transaction } = await import("../../lib/games");
      await transaction((client) => queueFinalReviews(client, workspace.gameId));
      assert.equal(await runMonitorWorkerOnce(timing), true);
      assert.equal(await runMonitorWorkerOnce(timing), true);
      const {
        rows: [finalized],
      } = await pool.query("SELECT status,monitor_version FROM ctf.games WHERE id=$1", [
        workspace.gameId,
      ]);
      assert.deepEqual(finalized, { status: "ended", monitor_version: version });
    }
    if (expectedMs)
      assert.ok(
        elapsed >= expectedMs - (realTiming ? 500 : 50) &&
          elapsed < expectedMs + (realTiming ? 10_000 : 3_000),
        `elapsed ${elapsed}ms`,
      );
  },
);
