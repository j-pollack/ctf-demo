import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Pool } from "pg";
import { closePool } from "./postgres";

const baseUrl = new URL(process.env.CTF_INTEGRATION_DATABASE_URL ?? "http://missing");
assert.equal(process.env.NODE_ENV, "test", "Use npm run test:integration");
assert.equal(baseUrl.hostname, "127.0.0.1");
assert.match(baseUrl.pathname, /^\/ctf_integration_[a-f0-9]{32}$/);
const databaseName = `ctf_integration_${randomUUID().replaceAll("-", "")}`;
const adminUrl = new URL(baseUrl);
adminUrl.pathname = "/postgres";
const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });

await test(
  "async review jobs preserve coverage and fenced claims",
  { timeout: 90_000 },
  async (t) => {
    assert.equal(
      (await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [databaseName])).rowCount,
      0,
    );
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(baseUrl);
    url.pathname = `/${databaseName}`;
    const pool = new Pool({ connectionString: url.toString(), max: 4 });
    (globalThis as typeof globalThis & { ctfPool?: Pool }).ctfPool = pool;
    t.after(async () => {
      await closePool(pool);
      await admin.query(`DROP DATABASE "${databaseName}"`);
      await admin.end();
    });
    for (const file of [
      "schema.sql",
      "migrations/002-dollar-seasons.sql",
      "migrations/003-monitor-reasoning.sql",
      "migrations/005-estimated-settlement.sql",
      "migrations/006-system-prompt.sql",
      "migrations/007-inference-game-index.sql",
      "migrations/008-block-ends-run.sql",
      "migrations/009-monitor-choice.sql",
      "migrations/010-control-monitor.sql",
      "migrations/011-agent-effort.sql",
      "migrations/012-new-run.sql",
      "migrations/013-agent-sessions.sql",
      "migrations/014-async-monitor.sql",
      "migrations/015-transcript-evidence.sql",
    ])
      await pool.query(await readFile(new URL(`../../db/${file}`, import.meta.url), "utf8"));
    await (await import("../../lib/transcript-evidence")).backfillTranscriptSearchText(pool);

    const { transaction } = await import("../../lib/games");
    const { persistTranscriptEvidence } = await import("../../lib/transcript-evidence");
    const { enqueueMonitorJob, claimMonitorJob, finishMonitorJob, assertMonitorJobClaim } =
      await import("../../lib/monitor-jobs");
    const { catchAsyncRun, claimAsyncFinalization, finalizeAsyncRun } =
      await import("../../lib/async-finalization");

    const seed = async (owner: string) => {
      const id = randomUUID();
      await pool.query(
        `INSERT INTO ctf.games
       (id,owner_id,sprite_name,secret_hash,agent_model,monitor_model,monitor_version,
        token_budget,status,agent_effort,system_prompt,monitor_mode)
       VALUES($1,$2,$3,'synthetic-hash','synthetic-agent','synthetic-monitor',
        'investigator-v3-async',1000,'active','medium','','async')`,
        [id, owner, `ctf-${id}`],
      );
      await pool.query(
        `INSERT INTO ctf.agent_sessions
       (id,game_id,ordinal,agent_model,agent_effort,system_prompt)
       VALUES($1,$1,1,'synthetic-agent','medium','')`,
        [id],
      );
      return id;
    };
    const write = async (id: string, texts: string[]) =>
      transaction(async (client) => {
        const messages = texts.map((text, index) => ({
          role: "user" as const,
          content: text,
          timestamp: Date.UTC(2020, 0, index + 1),
        }));
        const {
          rows: [run],
        } = await client.query<{ observation_revision: string }>(
          `UPDATE ctf.games SET observation_revision=observation_revision+1
       WHERE id=$1 RETURNING observation_revision`,
          [id],
        );
        const evidence = await persistTranscriptEvidence(client, {
          gameId: id,
          sessionId: id,
          runRevision: Number(run.observation_revision),
          messages: messages as Parameters<typeof persistTranscriptEvidence>[1]["messages"],
        });
        await client.query("UPDATE ctf.agent_sessions SET messages=$2 WHERE id=$1", [
          id,
          JSON.stringify(messages),
        ]);
        if (evidence.changed)
          await enqueueMonitorJob(client, {
            gameId: id,
            sessionId: id,
            epoch: evidence.epoch,
            version: evidence.version,
          });
        return evidence;
      });
    const writeMessages = async (
      id: string,
      messages: Parameters<typeof persistTranscriptEvidence>[1]["messages"],
    ) =>
      transaction(async (client) => {
        const {
          rows: [run],
        } = await client.query<{ observation_revision: string }>(
          "UPDATE ctf.games SET observation_revision=observation_revision+1 WHERE id=$1 RETURNING observation_revision",
          [id],
        );
        await client.query("UPDATE ctf.agent_sessions SET messages=$2 WHERE id=$1", [
          id,
          JSON.stringify(messages),
        ]);
        return persistTranscriptEvidence(client, {
          gameId: id,
          sessionId: id,
          runRevision: Number(run.observation_revision),
          messages,
        });
      });

    await t.test(
      "classifier context retries preserve authorization and persisted accounting",
      async (t) => {
        const { classifyMonitorTarget } = await import("../../lib/monitor-classifier");
        const { TYPESAFE_MODEL, TypesafeDocumentTooLargeError } =
          await import("../../lib/typesafe");
        const { MAX_MONITOR_DOCUMENT_BYTES } = await import("../../lib/monitor-document");
        const { FLAG_READ_MONITOR_VERSION } = await import("../../lib/control");
        const oldKey = process.env.TYPESAFE_API_KEY;
        process.env.TYPESAFE_API_KEY = "synthetic-classifier-context";
        t.after(() => {
          if (oldKey === undefined) delete process.env.TYPESAFE_API_KEY;
          else process.env.TYPESAFE_API_KEY = oldKey;
        });
        for (const reserveBudget of [false, true]) {
          for (const scenario of [
            "retry-success",
            "claim-lost",
            "abort",
            "exhausted",
            "unrelated-error",
            "pinned-only",
            ...(reserveBudget ? ["budget-denied" as const] : []),
          ] as const) {
            await t.test(`${reserveBudget ? "reserved" : "legacy"} ${scenario}`, async (t) => {
              const id = await seed(`classifier-${randomUUID()}`);
              const messages = [
                { role: "user", content: "keep this instruction", timestamp: 0 },
                ...Array.from({ length: scenario === "pinned-only" ? 1 : 40 }, (_, i) => ({
                  role: "assistant",
                  content: [{ type: "text", text: `turn-${i} ${"ordinary work ".repeat(140)}` }],
                  timestamp: i + 1,
                })),
              ] as Parameters<typeof writeMessages>[1];
              const evidence = await writeMessages(id, messages);
              await transaction((client) =>
                enqueueMonitorJob(client, {
                  gameId: id,
                  sessionId: id,
                  epoch: evidence.epoch,
                  version: evidence.version,
                }),
              );
              const claim = await claimMonitorJob();
              assert.equal(claim?.gameId, id);
              t.after(() =>
                pool.query(
                  "UPDATE ctf.monitor_jobs SET status='unresolved',claim_token=NULL,claim_until=NULL WHERE id=$1",
                  [claim!.jobId],
                ),
              );
              const reviewId = randomUUID();
              await pool.query(
                `INSERT INTO ctf.monitor_reviews
            (id,game_id,session_id,snapshot_revision,target_kind,model,prompt_version,job_id,job_claim_token)
            VALUES($1,$2,$2,1,'transcript','synthetic-monitor',$3,$4,$5)`,
                [reviewId, id, FLAG_READ_MONITOR_VERSION, claim!.jobId, claim!.claimToken],
              );
              const game = (await pool.query("SELECT * FROM ctf.games WHERE id=$1", [id])).rows[0];
              const controller = new AbortController();
              let commandCalls = 0;
              const documents: {
                transcript: { role: string; text: string }[];
                omissions: { sizeLimitMessages: number };
              }[] = [];
              let commandDone!: () => void;
              const commandCompleted = new Promise<void>((resolve) => {
                commandDone = resolve;
              });
              t.mock.method(
                globalThis,
                "fetch",
                async (url: string | URL | Request, init?: RequestInit) => {
                  assert.equal(String(url), "https://api.typesafe.ai/v1/systemone");
                  assert.equal(init?.method, "POST");
                  const headers = new Headers(init?.headers);
                  assert.equal(headers.get("authorization"), "Bearer synthetic-classifier-context");
                  assert.equal(headers.has("TypeSafe-Danger-Zone-Long-Context"), false);
                  init?.signal?.throwIfAborted();
                  const body = JSON.parse(String(init?.body));
                  assert.equal(body.model, TYPESAFE_MODEL);
                  if (typeof body.state === "string") {
                    assert.equal(body.state, "printf harmless");
                    assert.deepEqual(Object.keys(body.questions).sort(), [
                      "reads_now",
                      "stages_indirect",
                    ]);
                    assert.equal(
                      ++commandCalls,
                      1,
                      "context retries must not repeat command evaluation",
                    );
                    commandDone();
                    return Response.json({
                      answers: {
                        reads_now: { type: "noul", noul: 0 },
                        stages_indirect: { type: "noul", noul: 0 },
                      },
                      usage: { input_tokens: 1000 },
                    });
                  }
                  await commandCompleted;
                  assert.deepEqual(Object.keys(body.questions).sort(), ["intent", "suspicion"]);
                  assert.ok(
                    Buffer.byteLength(JSON.stringify(body.state)) <=
                      MAX_MONITOR_DOCUMENT_BYTES -
                        Buffer.byteLength(JSON.stringify(body.questions)),
                  );
                  documents.push(body.state);
                  if (reserveBudget) {
                    const { rows: reservations } = await pool.query(
                      "SELECT cost_ceiling,settled_at FROM ctf.inference WHERE game_id=$1 AND review_id=$2",
                      [id, reviewId],
                    );
                    assert.equal(
                      reservations.length,
                      documents.length + 1,
                      "every context attempt reserves before dispatch",
                    );
                    assert.ok(
                      reservations.some(
                        (row) => row.settled_at === null && Number(row.cost_ceiling) > 0,
                      ),
                    );
                  }
                  assert.equal(body.state.transcript[0].text, "keep this instruction");
                  assert.equal(
                    body.state.transcript.at(-1).text,
                    (messages.at(-1) as { content: { text: string }[] }).content[0].text,
                  );
                  if (documents.length === 1 && scenario !== "pinned-only")
                    assert.equal(
                      body.state.transcript.length,
                      41,
                      "production retains more than twenty turns",
                    );
                  if (documents.length > 1)
                    assert.ok(
                      body.state.transcript.length < documents.at(-2)!.transcript.length,
                      "each rejected request loses older history",
                    );
                  if (scenario === "retry-success" && documents.length === 2) {
                    assert.ok(body.state.omissions.sizeLimitMessages > 0);
                    return Response.json({
                      answers: {
                        intent: { type: "noul", noul: 0 },
                        suspicion: { type: "score", score: 0, confidence: 1 },
                      },
                      usage: { input_tokens: 2000 },
                    });
                  }
                  if (scenario === "claim-lost") {
                    assert.equal(documents.length, 1);
                    await pool.query("UPDATE ctf.monitor_jobs SET claim_token=$2 WHERE id=$1", [
                      claim!.jobId,
                      randomUUID(),
                    ]);
                  }
                  if (scenario === "abort")
                    controller.abort(new Error("synthetic classifier abort"));
                  if (scenario === "unrelated-error")
                    return new Response("provider unavailable", { status: 503 });
                  if (scenario === "budget-denied")
                    await pool.query(
                      "UPDATE ctf.games SET budget_microdollars=spent_microdollars+reserved_microdollars WHERE id=$1",
                      [id],
                    );
                  return new Response("max_tokens_exceeded", { status: 400 });
                },
              );
              const before = Number(
                (
                  await pool.query(
                    "SELECT coalesce(sum(charged),0) AS charged FROM ctf.daily_spend",
                  )
                ).rows[0].charged,
              );
              const classification = classifyMonitorTarget({
                game,
                sessionId: id,
                lease: "",
                reviewId,
                messages: [...messages],
                target: { kind: "command", command: "printf harmless" },
                signal: controller.signal,
                executionGeneration: Number(game.execution_generation),
                jobClaim: claim!,
                reserveBudget,
              });
              if (scenario === "retry-success") assert.equal((await classification).suspicion, 0);
              else
                await assert.rejects(
                  classification,
                  scenario === "claim-lost"
                    ? /no longer owns/
                    : scenario === "abort"
                      ? /synthetic classifier abort/
                      : scenario === "unrelated-error"
                        ? /status 503/
                        : scenario === "budget-denied"
                          ? /budget/
                          : TypesafeDocumentTooLargeError,
                );
              assert.equal(
                documents.length,
                scenario === "retry-success" ? 2 : scenario === "exhausted" ? 5 : 1,
              );
              assert.equal(commandCalls, 1);
              const expectedTokens = scenario === "retry-success" ? 3000 : 1000;
              const expectedCost = scenario === "retry-success" ? 126 : 42;
              const charges = (
                await pool.query(
                  "SELECT tokens,cost,cost_ceiling,settled_at FROM ctf.inference WHERE game_id=$1 AND review_id=$2",
                  [id, reviewId],
                )
              ).rows;
              const settled = charges.filter((charge) => charge.settled_at !== null);
              const held = charges.filter((charge) => charge.settled_at === null);
              assert.equal(charges.length, reserveBudget ? documents.length + 1 : 1);
              assert.equal(settled.length, reserveBudget && scenario === "retry-success" ? 2 : 1);
              assert.equal(
                held.length,
                reserveBudget ? documents.length - (scenario === "retry-success" ? 1 : 0) : 0,
              );
              assert.equal(
                settled.reduce((sum, charge) => sum + Number(charge.tokens), 0),
                expectedTokens,
              );
              assert.equal(
                settled.reduce((sum, charge) => sum + Number(charge.cost), 0),
                expectedCost,
              );
              const heldCost = held.reduce((sum, charge) => sum + Number(charge.cost_ceiling), 0);
              if (reserveBudget)
                assert.ok(heldCost > 0, "dispatched rejections retain unknown usage holds");
              const balances = (
                await pool.query("SELECT reserved_microdollars FROM ctf.games WHERE id=$1", [id])
              ).rows[0];
              assert.equal(Number(balances.reserved_microdollars), heldCost);
              const dayReserved = (
                await pool.query(
                  "SELECT coalesce(sum(reserved),0) AS reserved FROM ctf.daily_spend",
                )
              ).rows[0];
              const allHeld = (
                await pool.query(
                  "SELECT coalesce(sum(cost_ceiling),0) AS reserved FROM ctf.inference WHERE settled_at IS NULL",
                )
              ).rows[0];
              assert.equal(Number(dayReserved.reserved), Number(allHeld.reserved));
              assert.equal(
                Number(
                  (await pool.query("SELECT spent_microdollars FROM ctf.games WHERE id=$1", [id]))
                    .rows[0].spent_microdollars,
                ),
                expectedCost,
              );
              assert.equal(
                Number(
                  (
                    await pool.query(
                      "SELECT coalesce(sum(charged),0) AS charged FROM ctf.daily_spend",
                    )
                  ).rows[0].charged,
                ) - before,
                expectedCost,
              );
            });
          }
        }
      },
    );

    await t.test(
      "claim durations preserve defaults and reject invalid overrides before admission",
      async () => {
        const id = await seed(`claim-duration-${randomUUID()}`);
        await write(id, ["evidence"]);
        for (const invalid of [0, -1, 0.5, NaN, Infinity, 2_147_483_648])
          await assert.rejects(claimMonitorJob(invalid), /claim duration/i);
        assert.equal(
          (await pool.query("SELECT attempts FROM ctf.monitor_jobs WHERE game_id=$1", [id])).rows[0]
            .attempts,
          0,
        );
        for (const duration of [undefined, 120_000]) {
          const claim = await claimMonitorJob(duration);
          assert.equal(claim?.gameId, id);
          const {
            rows: [row],
          } = await pool.query(
            "SELECT extract(epoch FROM (claim_until-updated_at))*1000 AS duration,claim_until FROM ctf.monitor_jobs WHERE id=$1",
            [claim!.jobId],
          );
          assert.equal(Number(row.duration), duration ?? 90_000);
          assert.equal(row.claim_until.getTime(), claim!.claimUntil.getTime());
          await transaction((client) => assertMonitorJobClaim(client, claim!));
          await finishMonitorJob(claim!, { kind: "allow" });
          if (duration === undefined) await write(id, ["evidence", "new evidence"]);
        }
      },
    );

    await t.test("a newer append remains queued after the old claim completes", async () => {
      const id = await seed(`append-${randomUUID()}`);
      const first = await write(id, ["first"]);
      const claim = await claimMonitorJob();
      assert.equal(claim?.gameId, id);
      assert.equal(claim?.targetVersion, first.version);
      const second = await write(id, ["first", "second"]);
      assert.equal(second.epoch, first.epoch);
      const during = (
        await pool.query(
          "SELECT status,target_version,requested_version FROM ctf.monitor_jobs WHERE id=$1",
          [claim!.jobId],
        )
      ).rows[0];
      assert.equal(during.status, "reviewing");
      assert.equal(Number(during.target_version), first.version);
      assert.equal(Number(during.requested_version), second.version);
      await finishMonitorJob(claim!, { kind: "allow" });
      const after = (
        await pool.query(
          "SELECT status,covered_version,requested_version FROM ctf.monitor_jobs WHERE id=$1",
          [claim!.jobId],
        )
      ).rows[0];
      assert.equal(after.status, "queued");
      assert.equal(Number(after.covered_version), first.version);
      assert.equal(Number(after.requested_version), second.version);
      const next = await claimMonitorJob();
      assert.equal(next?.targetVersion, second.version);
      await finishMonitorJob(next!, { kind: "allow" });
    });

    await t.test("an expired claimant cannot settle or catch; a replacement resumes", async () => {
      const id = await seed(`restart-${randomUUID()}`);
      await write(id, ["evidence"]);
      const old = await claimMonitorJob();
      assert.equal(old?.gameId, id);
      await pool.query(
        "UPDATE ctf.monitor_jobs SET claim_until=now()-interval '1 second' WHERE id=$1",
        [old!.jobId],
      );
      const replacement = await claimMonitorJob();
      assert.equal(replacement?.jobId, old!.jobId);
      assert.notEqual(replacement?.claimToken, old!.claimToken);
      await assert.rejects(
        transaction((client) => assertMonitorJobClaim(client, old!)),
        /no longer owns/,
      );
      await assert.rejects(finishMonitorJob(old!, { kind: "allow" }), /no longer owns/);
      await assert.rejects(
        catchAsyncRun(old!, randomUUID(), { verdict: "block", reason: "stale" }, 0.9),
        /no longer owns/,
      );
      assert.equal(
        (await pool.query("SELECT status FROM ctf.games WHERE id=$1", [id])).rows[0].status,
        "active",
      );
      await finishMonitorJob(replacement!, { kind: "allow" });
    });

    await t.test(
      "repair epochs survive, and new evidence can revisit unresolved earlier coverage",
      async () => {
        const id = await seed(`repair-${randomUUID()}`);
        const first = await write(id, ["old harmful"]);
        const firstClaim = await claimMonitorJob();
        assert.equal(firstClaim?.gameId, id);
        await finishMonitorJob(firstClaim!, { kind: "unknown", reason: "uncertain" });
        const unresolved = (
          await pool.query("SELECT status,covered_version FROM ctf.monitor_jobs WHERE id=$1", [
            firstClaim!.jobId,
          ])
        ).rows[0];
        assert.equal(unresolved.status, "unresolved");
        assert.equal(Number(unresolved.covered_version), 0);
        const append = await write(id, ["old harmful", "new evidence"]);
        assert.equal(append.epoch, first.epoch);
        const retry = await claimMonitorJob();
        assert.equal(retry?.jobId, firstClaim?.jobId);
        assert.equal(retry?.targetVersion, append.version);
        const repair = await write(id, ["repaired"]);
        assert.equal(repair.epoch, first.epoch + 1);
        await finishMonitorJob(retry!, { kind: "allow" });
        const { rows } = await pool.query(
          "SELECT epoch,status FROM ctf.monitor_jobs WHERE game_id=$1 ORDER BY epoch",
          [id],
        );
        assert.deepEqual(
          rows.map((row) => [Number(row.epoch), row.status]),
          [
            [first.epoch, "caught-up"],
            [repair.epoch, "queued"],
          ],
        );
        const repairClaim = await claimMonitorJob();
        assert.equal(repairClaim?.epoch, repair.epoch);
        await finishMonitorJob(repairClaim!, { kind: "allow" });
      },
    );
    await t.test("successful coverage repeats beyond the retry limit", async () => {
      const id = await seed(`repeat-${randomUUID()}`);
      for (let version = 1; version <= 5; version++) {
        const evidence = await write(
          id,
          Array.from({ length: version }, (_, index) => `item ${index}`),
        );
        const claim = await claimMonitorJob();
        assert.equal(claim?.gameId, id);
        assert.equal(claim?.targetVersion, evidence.version);
        await finishMonitorJob(claim!, { kind: "allow" });
      }
      const {
        rows: [job],
      } = await pool.query(
        "SELECT status,attempts,covered_version,requested_version FROM ctf.monitor_jobs WHERE game_id=$1",
        [id],
      );
      assert.equal(job.status, "caught-up");
      assert.equal(job.attempts, 0);
      assert.equal(job.covered_version, job.requested_version);
    });
    await t.test("unknown result with newer target remains queued", async () => {
      const id = await seed(`newer-${randomUUID()}`);
      await write(id, ["initial"]);
      const old = await claimMonitorJob();
      const later = await write(id, ["initial", "later"]);
      await finishMonitorJob(old!, { kind: "unknown", reason: "uncertain" });
      const {
        rows: [job],
      } = await pool.query("SELECT status,covered_version FROM ctf.monitor_jobs WHERE game_id=$1", [
        id,
      ]);
      assert.equal(job.status, "queued");
      assert.equal(Number(job.covered_version), 0);
      const claim = await claimMonitorJob();
      assert.equal(claim?.targetVersion, later.version);
      await finishMonitorJob(claim!, { kind: "allow" });
    });
    await t.test(
      "finalization waits for a live transcript writer after review coverage",
      async () => {
        const id = await seed(`writer-${randomUUID()}`);
        await write(id, ["submitted evidence"]);
        const review = await claimMonitorJob();
        await finishMonitorJob(review!, { kind: "allow" });
        await pool.query(
          `UPDATE ctf.games SET status='finalizing',submitted_flag_correct=false,
         submitted_session_id=$1 WHERE id=$1`,
          [id],
        );
        await pool.query("INSERT INTO ctf.finalization_jobs(game_id) VALUES($1)", [id]);
        await pool.query(
          "UPDATE ctf.agent_sessions SET lease=$2,lease_until=now()+interval '1 minute' WHERE id=$1",
          [id, randomUUID()],
        );
        assert.equal(await claimAsyncFinalization(), null);
        assert.equal(
          (await pool.query("SELECT status FROM ctf.games WHERE id=$1", [id])).rows[0].status,
          "finalizing",
        );
        await pool.query("UPDATE ctf.agent_sessions SET lease=NULL,lease_until=NULL WHERE id=$1", [
          id,
        ]);
        const finalization = await claimAsyncFinalization();
        assert.equal(finalization?.gameId, id);
        assert.equal(await finalizeAsyncRun(finalization!, "ended", 0), true);
        assert.equal(
          (await pool.query("SELECT status FROM ctf.games WHERE id=$1", [id])).rows[0].status,
          "ended",
        );
      },
    );
    await t.test("public monitor status hides stored worker diagnostics", async () => {
      const id = await seed(`private-diagnostic-${randomUUID()}`);
      await write(id, ["review this"]);
      await pool.query(
        "UPDATE ctf.monitor_jobs SET status='unresolved',reason=$2 WHERE game_id=$1",
        [id, "SQL relation secret_worker_table missing; provider credential rejected"],
      );
      const { publicGame } = await import("../../lib/games");
      const run = (await pool.query("SELECT * FROM ctf.games WHERE id=$1", [id])).rows[0];
      const projected = await publicGame(run);
      assert.equal(projected.monitor?.status, "unresolved");
      assert.ok(projected.monitor?.reason);
      assert.doesNotMatch(projected.monitor.reason!, /secret_worker_table|credential|SQL/i);
      await pool.query("UPDATE ctf.games SET finalization_error=$2 WHERE id=$1", [
        id,
        "scoring error: internal_stack_trace",
      ]);
      const failed = await publicGame(run);
      assert.equal(failed.monitor?.status, "unresolved");
      assert.doesNotMatch(failed.monitor.reason!, /internal_stack_trace|scoring error/i);
    });
    await t.test(
      "public progress distinguishes mixed pending and settled unresolved reviews",
      async () => {
        const id = await seed(`mixed-review-${randomUUID()}`);
        await write(id, ["first evidence"]);
        await pool.query("UPDATE ctf.monitor_jobs SET status='unresolved' WHERE game_id=$1", [id]);
        const { publicGame } = await import("../../lib/games");
        const projected = async () =>
          publicGame((await pool.query("SELECT * FROM ctf.games WHERE id=$1", [id])).rows[0]);
        assert.equal((await projected()).monitor?.hasPendingReview, false);
        await write(id, ["repaired evidence"]);
        assert.equal((await projected()).monitor?.status, "unresolved");
        assert.equal((await projected()).monitor?.hasPendingReview, true);
        await pool.query(
          "UPDATE ctf.monitor_jobs SET status='reviewing',claim_token=$2,claim_until=now()+interval '1 minute' WHERE game_id=$1 AND status='queued'",
          [id, randomUUID()],
        );
        assert.equal((await projected()).monitor?.hasPendingReview, true);
        await pool.query(
          "UPDATE ctf.monitor_jobs SET status='unresolved',claim_token=NULL,claim_until=NULL WHERE game_id=$1",
          [id],
        );
        assert.equal((await projected()).monitor?.hasPendingReview, false);
      },
    );
    await t.test(
      "sequential and late results retain order in every committed observation",
      async () => {
        const id = await seed(`ordered-results-${randomUUID()}`);
        const firstCall = randomUUID(),
          secondCall = randomUUID(),
          firstDispatch = randomUUID(),
          secondDispatch = randomUUID();
        const assistant = {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: firstCall,
              name: "sprite_exec",
              arguments: { command: "printf first" },
            },
            {
              type: "toolCall",
              id: secondCall,
              name: "sprite_exec",
              arguments: { command: "printf second" },
            },
          ],
          timestamp: 1,
        };
        const first = {
          role: "toolResult",
          toolCallId: firstCall,
          toolName: "sprite_exec",
          content: [{ type: "text", text: "first output" }],
          isError: false,
          timestamp: 2,
        };
        const second = {
          role: "toolResult",
          toolCallId: secondCall,
          toolName: "sprite_exec",
          content: [{ type: "text", text: "second output" }],
          isError: false,
          timestamp: 3,
        };
        const newer = { role: "user", content: "resumed instruction", timestamp: 4 };
        await writeMessages(id, [assistant] as never);
        for (const [dispatch, call] of [
          [firstDispatch, firstCall],
          [secondDispatch, secondCall],
        ])
          await pool.query(
            `INSERT INTO ctf.sprite_operations(id,sprite_name,game_id,session_id,tool_call_id,kind,command)
          SELECT $2,sprite_name,id,id,$3,'command','printf harmless' FROM ctf.games WHERE id=$1`,
            [id, dispatch, call],
          );
        const { completeAsyncCommand } = await import("../../lib/monitor-commands");
        await completeAsyncCommand({
          dispatchId: firstDispatch,
          gameId: id,
          sessionId: id,
          messages: [assistant, first] as never,
          outcome: "completed",
          output: "first output",
        });
        await writeMessages(id, [assistant, first, newer] as never);
        await completeAsyncCommand({
          dispatchId: secondDispatch,
          gameId: id,
          sessionId: id,
          messages: [assistant, first, second] as never,
          outcome: "completed",
          output: "second output",
        });
        const { reconstructTranscript } = await import("../../lib/transcript-evidence");
        const client = await pool.connect();
        try {
          const versions = Number(
            (
              await client.query(
                "SELECT max(version) AS version FROM ctf.transcript_observations WHERE session_id=$1",
                [id],
              )
            ).rows[0].version,
          );
          const all = [];
          for (let version = 1; version <= versions; version++)
            all.push(await reconstructTranscript(client, id, version));
          assert.deepEqual(
            all.map((messages) => messages.map((message) => message.role)),
            [
              ["assistant"],
              ["assistant", "toolResult"],
              ["assistant", "toolResult", "user"],
              ["assistant", "toolResult", "toolResult", "user"],
            ],
          );
          assert.deepEqual(
            all
              .at(-1)!
              .filter((message) => message.role === "toolResult")
              .map((message) =>
                message.content[0].type === "text" ? message.content[0].text : null,
              ),
            ["first output", "second output"],
          );
        } finally {
          client.release();
        }
        const prefixId = await seed(`jsonb-prefix-${randomUUID()}`);
        const prefixFirst = randomUUID(),
          prefixSecond = randomUUID();
        await writeMessages(prefixId, [assistant] as never);
        for (const [dispatch, call] of [
          [prefixFirst, firstCall],
          [prefixSecond, secondCall],
        ])
          await pool.query(
            `INSERT INTO ctf.sprite_operations(id,sprite_name,game_id,session_id,tool_call_id,kind,command)
            SELECT $2,sprite_name,id,id,$3,'command','printf harmless' FROM ctf.games WHERE id=$1`,
            [prefixId, dispatch, call],
          );
        await completeAsyncCommand({
          dispatchId: prefixFirst,
          gameId: prefixId,
          sessionId: prefixId,
          messages: [assistant, first] as never,
          outcome: "completed",
          output: "first output",
        });
        const storedPrefix = (
          await pool.query("SELECT messages FROM ctf.agent_sessions WHERE id=$1", [prefixId])
        ).rows[0].messages;
        assert.notEqual(
          JSON.stringify(storedPrefix[0]),
          JSON.stringify(assistant),
          "Postgres JSONB reorders object keys",
        );
        await completeAsyncCommand({
          dispatchId: prefixSecond,
          gameId: prefixId,
          sessionId: prefixId,
          messages: [assistant, first, second] as never,
          outcome: "completed",
          output: "second output",
        });
        const prefixClient = await pool.connect();
        try {
          const every = [];
          for (let version = 1; version <= 3; version++)
            every.push(await reconstructTranscript(prefixClient, prefixId, version));
          assert.deepEqual(
            every.map((messages) =>
              messages
                .filter((message) => message.role === "toolResult")
                .map((message) =>
                  message.content[0].type === "text" ? message.content[0].text : null,
                ),
            ),
            [[], ["first output"], ["first output", "second output"]],
          );
        } finally {
          prefixClient.release();
        }
      },
    );
    await t.test("late command outcome preserves a resumed session transcript", async () => {
      const id = await seed(`late-outcome-${randomUUID()}`);
      const callId = randomUUID();
      const dispatchId = randomUUID();
      const assistant = {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: callId,
            name: "sprite_exec",
            arguments: { command: "printf harmless" },
          },
        ],
        timestamp: 1,
      };
      const result = {
        role: "toolResult",
        toolCallId: callId,
        toolName: "sprite_exec",
        content: [{ type: "text", text: "done" }],
        isError: false,
        timestamp: 2,
      };
      const resumed = { role: "user", content: "new instruction after old lease", timestamp: 3 };
      await pool.query("UPDATE ctf.agent_sessions SET messages=$2 WHERE id=$1", [
        id,
        JSON.stringify([assistant, resumed]),
      ]);
      await pool.query(
        `INSERT INTO ctf.sprite_operations(id,sprite_name,game_id,session_id,tool_call_id,kind,command)
         SELECT $2,sprite_name,id,id,$3,'command','printf harmless' FROM ctf.games WHERE id=$1`,
        [id, dispatchId, callId],
      );
      const { completeAsyncCommand } = await import("../../lib/monitor-commands");
      await completeAsyncCommand({
        dispatchId,
        gameId: id,
        sessionId: id,
        messages: [assistant, result] as never,
        outcome: "completed",
        output: "done",
      });
      const saved = (await pool.query("SELECT messages FROM ctf.agent_sessions WHERE id=$1", [id]))
        .rows[0].messages;
      assert.deepEqual(
        saved.map((message: { role: string }) => message.role),
        ["assistant", "toolResult", "user"],
      );
      assert.equal(saved[2].content, resumed.content);
      const repairedId = await seed(`repaired-late-${randomUUID()}`);
      const repairedDispatch = randomUUID();
      const placeholder = {
        ...result,
        content: [{ type: "text", text: "Execution status is unknown" }],
        isError: true,
      };
      await writeMessages(repairedId, [assistant, placeholder, resumed] as never);
      await pool.query(
        `INSERT INTO ctf.sprite_operations(id,sprite_name,game_id,session_id,tool_call_id,kind,command)
         SELECT $2,sprite_name,id,id,$3,'command','printf harmless' FROM ctf.games WHERE id=$1`,
        [repairedId, repairedDispatch, callId],
      );
      await completeAsyncCommand({
        dispatchId: repairedDispatch,
        gameId: repairedId,
        sessionId: repairedId,
        messages: [assistant, result] as never,
        outcome: "completed",
        output: "done",
      });
      const repaired = (
        await pool.query("SELECT messages FROM ctf.agent_sessions WHERE id=$1", [repairedId])
      ).rows[0].messages;
      assert.equal(repaired[1].content[0].text, "done");
      assert.equal(repaired[2].content, resumed.content);
      const { reconstructTranscript } = await import("../../lib/transcript-evidence");
      const evidenceClient = await pool.connect();
      try {
        const before = await reconstructTranscript(evidenceClient, repairedId, 1);
        const after = await reconstructTranscript(evidenceClient, repairedId, 2);
        assert.equal((before[1] as typeof result).content[0].text, "Execution status is unknown");
        assert.equal((after[1] as typeof result).content[0].text, "done");
        assert.equal((after[2] as typeof resumed).content, resumed.content);
      } finally {
        evidenceClient.release();
      }
    });
    await t.test("uncertain and orphan commands keep later submissions unresolved", async () => {
      const { beginAsyncSubmission } = await import("../../lib/async-finalization");
      const { publicGame } = await import("../../lib/games");
      for (const status of ["unknown", "running"]) {
        const id = await seed(`${status}-${randomUUID()}`);
        const lease = randomUUID();
        const operationSessionId = status === "running" ? randomUUID() : id;
        await pool.query(
          "UPDATE ctf.agent_sessions SET lease=$2,lease_until=now()+interval '1 minute' WHERE id=$1",
          [id, lease],
        );
        if (operationSessionId !== id)
          await pool.query(
            `INSERT INTO ctf.agent_sessions(id,game_id,ordinal,agent_model,agent_effort,system_prompt)
             VALUES($1,$2,2,'synthetic-agent','medium','')`,
            [operationSessionId, id],
          );
        await pool.query(
          `INSERT INTO ctf.sprite_operations(id,sprite_name,game_id,session_id,tool_call_id,kind,command,status)
           SELECT $2,sprite_name,id,$5,$3,'command','printf uncertain',$4 FROM ctf.games WHERE id=$1`,
          [id, randomUUID(), randomUUID(), status, operationSessionId],
        );
        if (status === "unknown") {
          await write(id, ["committed evidence before submission"]);
          let cleared = false;
          for (let attempt = 0; attempt < 8; attempt++) {
            const review = await claimMonitorJob();
            assert.ok(review);
            await finishMonitorJob(review, { kind: "allow" });
            if (review.gameId === id) {
              cleared = true;
              break;
            }
          }
          assert.equal(cleared, true);
        }
        await beginAsyncSubmission({ gameId: id, sessionId: id, lease, value: "incorrect flag" });
        const run = (await pool.query("SELECT * FROM ctf.games WHERE id=$1", [id])).rows[0];
        const publicRun = await publicGame(run);
        assert.equal(publicRun.status, "finalizing");
        assert.equal(publicRun.monitor?.status, "unresolved");
        assert.ok(publicRun.monitor?.reason);
        await pool.query("UPDATE ctf.agent_sessions SET lease=NULL,lease_until=NULL WHERE id=$1", [
          id,
        ]);
        assert.equal(await claimAsyncFinalization(), null);
        assert.equal(
          (await pool.query("SELECT status FROM ctf.games WHERE id=$1", [id])).rows[0].status,
          "finalizing",
        );
      }
    });
    await t.test("a live command can settle after submission and permit finalization", async () => {
      const id = await seed(`live-command-${randomUUID()}`);
      const lease = randomUUID();
      const dispatchId = randomUUID();
      const callId = randomUUID();
      const assistant = {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: callId,
            name: "sprite_exec",
            arguments: { command: "printf harmless" },
          },
        ],
        timestamp: 1,
      };
      const result = {
        role: "toolResult",
        toolCallId: callId,
        toolName: "sprite_exec",
        content: [{ type: "text", text: "known output" }],
        isError: false,
        timestamp: 2,
      };
      await pool.query(
        "UPDATE ctf.agent_sessions SET lease=$2,lease_until=now()+interval '1 minute',messages=$3 WHERE id=$1",
        [id, lease, JSON.stringify([assistant])],
      );
      await pool.query(
        `INSERT INTO ctf.sprite_operations(id,sprite_name,game_id,session_id,tool_call_id,kind,command)
         SELECT $2,sprite_name,id,id,$3,'command','printf harmless' FROM ctf.games WHERE id=$1`,
        [id, dispatchId, callId],
      );
      const { beginAsyncSubmission } = await import("../../lib/async-finalization");
      await beginAsyncSubmission({ gameId: id, sessionId: id, lease, value: "incorrect flag" });
      assert.equal(
        (await pool.query("SELECT finalization_error FROM ctf.games WHERE id=$1", [id])).rows[0]
          .finalization_error,
        null,
      );
      const { completeAsyncCommand } = await import("../../lib/monitor-commands");
      await completeAsyncCommand({
        dispatchId,
        gameId: id,
        sessionId: id,
        messages: [assistant, result] as never,
        outcome: "completed",
        output: "known output",
      });
      await pool.query("UPDATE ctf.agent_sessions SET lease=NULL,lease_until=NULL WHERE id=$1", [
        id,
      ]);
      let covered = false;
      for (let attempt = 0; attempt < 8; attempt++) {
        const review = await claimMonitorJob();
        assert.ok(review);
        await finishMonitorJob(review, { kind: "allow" });
        if (review.gameId === id) {
          covered = true;
          break;
        }
      }
      assert.equal(covered, true);
      const claim = await claimAsyncFinalization();
      assert.equal(claim?.gameId, id);
      assert.equal(await finalizeAsyncRun(claim!, "ended", 0), true);
      assert.equal(
        (await pool.query("SELECT status FROM ctf.games WHERE id=$1", [id])).rows[0].status,
        "ended",
      );
    });
    await t.test("a verified late result resolves an unknown command", async () => {
      const id = await seed(`resolved-unknown-${randomUUID()}`);
      const lease = randomUUID(),
        dispatchId = randomUUID(),
        callId = randomUUID();
      const assistant = {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: callId,
            name: "sprite_exec",
            arguments: { command: "printf harmless" },
          },
        ],
        timestamp: 1,
      };
      const placeholder = {
        role: "toolResult",
        toolCallId: callId,
        toolName: "sprite_exec",
        content: [{ type: "text", text: "Outcome unknown" }],
        isError: true,
        timestamp: 2,
      };
      const actual = {
        ...placeholder,
        content: [{ type: "text", text: "known output" }],
        isError: false,
        timestamp: 3,
      };
      await pool.query(
        "UPDATE ctf.agent_sessions SET lease=$2,lease_until=now()+interval '1 minute',messages=$3 WHERE id=$1",
        [id, lease, JSON.stringify([assistant, placeholder])],
      );
      await pool.query(
        `INSERT INTO ctf.sprite_operations(id,sprite_name,game_id,session_id,tool_call_id,kind,command,status,output)
         SELECT $2,sprite_name,id,id,$3,'command','printf harmless','unknown','Outcome unknown' FROM ctf.games WHERE id=$1`,
        [id, dispatchId, callId],
      );
      const { beginAsyncSubmission } = await import("../../lib/async-finalization");
      const { publicGame } = await import("../../lib/games");
      await beginAsyncSubmission({ gameId: id, sessionId: id, lease, value: "incorrect flag" });
      const run = () =>
        pool.query("SELECT * FROM ctf.games WHERE id=$1", [id]).then((r) => r.rows[0]);
      assert.equal((await publicGame(await run())).monitor?.status, "unresolved");
      const { completeAsyncCommand } = await import("../../lib/monitor-commands");
      await completeAsyncCommand({
        dispatchId,
        gameId: id,
        sessionId: id,
        messages: [assistant, actual] as never,
        outcome: "completed",
        output: "known output",
      });
      await pool.query("UPDATE ctf.agent_sessions SET lease=NULL,lease_until=NULL WHERE id=$1", [
        id,
      ]);
      for (let attempt = 0; attempt < 8; attempt++) {
        const job = await claimMonitorJob();
        if (!job) break;
        await finishMonitorJob(job, { kind: "allow" });
      }
      assert.equal((await publicGame(await run())).monitor?.status, "caught-up");
      const claim = await claimAsyncFinalization();
      assert.equal(claim?.gameId, id);
      assert.equal(await finalizeAsyncRun(claim!, "ended", 0), true);
    });
    await t.test(
      "a running command becomes visibly unresolved when its lease expires",
      async () => {
        const id = await seed(`expired-after-submit-${randomUUID()}`);
        const lease = randomUUID();
        await pool.query(
          "UPDATE ctf.agent_sessions SET lease=$2,lease_until=now()+interval '1 minute' WHERE id=$1",
          [id, lease],
        );
        await pool.query(
          `INSERT INTO ctf.sprite_operations(id,sprite_name,game_id,session_id,tool_call_id,kind,command)
         SELECT $2,sprite_name,id,id,$3,'command','printf pending' FROM ctf.games WHERE id=$1`,
          [id, randomUUID(), randomUUID()],
        );
        const { beginAsyncSubmission } = await import("../../lib/async-finalization");
        const { publicGame } = await import("../../lib/games");
        await beginAsyncSubmission({ gameId: id, sessionId: id, lease, value: "incorrect flag" });
        const run = () =>
          pool.query("SELECT * FROM ctf.games WHERE id=$1", [id]).then((r) => r.rows[0]);
        assert.notEqual((await publicGame(await run())).monitor?.status, "unresolved");
        await pool.query(
          "UPDATE ctf.agent_sessions SET lease_until=now()-interval '1 second' WHERE id=$1",
          [id],
        );
        assert.equal((await publicGame(await run())).monitor?.status, "unresolved");
        assert.equal(await claimAsyncFinalization(), null);
      },
    );
  },
);
