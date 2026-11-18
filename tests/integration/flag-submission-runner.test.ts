import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { SpritesClient } from "@fly/sprites";
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
  "HTTP receipt fences dispatch and drains admitted Sprite commands",
  { timeout: 90_000 },
  async (t) => {
    assert.equal(
      (await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [databaseName])).rowCount,
      0,
    );
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(baseUrl);
    url.pathname = `/${databaseName}`;
    const pool = new Pool({ connectionString: url.toString(), max: 5 });
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
      "migrations/017-settings.sql",
      "migrations/018-monitor-ready.sql",
      "migrations/019-session-stop.sql",
      "migrations/020-http-flag-submission.sql",
      "migrations/021-game-rules.sql",
    ])
      await pool.query(await readFile(new URL(`../../db/${file}`, import.meta.url), "utf8"));

    const { claimSession, releaseSessionLease } = await import("../../lib/sessions");
    const { dispatchAsyncCommand, completeAsyncCommand } =
      await import("../../lib/monitor-commands");
    const { receiveFlagSubmission } = await import("../../lib/flag-submissions");
    const { beginAsyncSubmission, claimAsyncFinalization } =
      await import("../../lib/async-finalization");
    const { makeSecret } = await import("../../lib/policy");
    const owner = randomUUID();
    const gameId = randomUUID();
    const siblingId = randomUUID();
    const { secret, hash } = makeSecret();
    await pool.query(
      `INSERT INTO ctf.games(id,owner_id,sprite_name,secret_hash,agent_model,monitor_model,
      monitor_version,token_budget,status,agent_effort,system_prompt,monitor_mode,submission_transport)
     VALUES($1,$2,$3,$4,'synthetic-agent','synthetic-monitor','investigator-v3-async',
      1000,'active','medium','','async','http')`,
      [gameId, owner, `ctf-${gameId}`, hash],
    );
    await pool.query(
      `INSERT INTO ctf.agent_sessions(id,game_id,ordinal,agent_model,agent_effort,system_prompt)
     VALUES($1,$1,1,'synthetic-agent','medium',''),
       ($2,$1,2,'synthetic-agent','medium','')`,
      [gameId, siblingId],
    );
    const firstLease = (await claimSession(gameId, gameId, owner)).lease;
    const siblingLease = (await claimSession(gameId, siblingId, owner)).lease;
    const first = await dispatchAsyncCommand({
      gameId,
      sessionId: gameId,
      lease: firstLease,
      toolCallId: "call-upload",
      command: "curl --data-binary @/tmp/flag.txt",
      generation: 0,
    });
    const sibling = await dispatchAsyncCommand({
      gameId,
      sessionId: siblingId,
      lease: siblingLease,
      toolCallId: "call-sibling",
      command: "sleep 2",
      generation: 0,
    });
    assert.match(first.submissionToken ?? "", /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(first.submissionToken, sibling.submissionToken);
    assert.equal(
      await receiveFlagSubmission({ token: first.submissionToken!, value: secret }),
      "accepted",
    );
    assert.equal(
      await receiveFlagSubmission({ token: first.submissionToken!, value: secret }),
      "accepted",
    );
    await assert.rejects(
      dispatchAsyncCommand({
        gameId,
        sessionId: siblingId,
        lease: siblingLease,
        toolCallId: "call-late",
        command: "printf late",
        generation: 0,
      }),
      /already been submitted/,
    );
    await assert.rejects(claimSession(gameId, gameId, owner), /already been submitted/);
    await assert.rejects(
      beginAsyncSubmission({ gameId, sessionId: gameId, lease: firstLease, value: secret }),
      /ended/,
    );
    assert.equal(await claimAsyncFinalization(), null);

    await completeAsyncCommand({
      dispatchId: first.id,
      gameId,
      sessionId: gameId,
      messages: [],
      outcome: "completed",
      output: "\n[exit 0]",
    });
    assert.equal(
      (await pool.query("SELECT status FROM ctf.games WHERE id=$1", [gameId])).rows[0].status,
      "active",
    );
    await completeAsyncCommand({
      dispatchId: sibling.id,
      gameId,
      sessionId: siblingId,
      messages: [],
      outcome: "completed",
      output: "done\n[exit 0]",
    });
    const run = (
      await pool.query("SELECT status,submitted_flag_correct FROM ctf.games WHERE id=$1", [gameId])
    ).rows[0];
    assert.deepEqual(run, { status: "finalizing", submitted_flag_correct: true });
    assert.equal(
      (
        await pool.query("SELECT count(*)::int AS n FROM ctf.finalization_jobs WHERE game_id=$1", [
          gameId,
        ])
      ).rows[0].n,
      1,
    );
    const events = (
      await pool.query("SELECT data FROM ctf.events WHERE game_id=$1 ORDER BY id", [gameId])
    ).rows.map((row) => row.data);
    assert.equal(events.filter((event) => event.kind === "submit").length, 1);
    assert.equal(
      events.some((event) => JSON.stringify(event).includes(secret)),
      false,
    );
    assert.equal(
      events.some((event) => event.kind === "submit" && event.correct !== undefined),
      false,
    );
    const unknownId = randomUUID();
    await pool.query(
      `INSERT INTO ctf.games(id,owner_id,sprite_name,secret_hash,agent_model,monitor_model,
        monitor_version,token_budget,status,agent_effort,system_prompt,monitor_mode,submission_transport)
       VALUES($1,$2,$3,$4,'synthetic-agent','synthetic-monitor','investigator-v3-async',
        1000,'active','medium','','async','http')`,
      [unknownId, owner, `ctf-${unknownId}`, hash],
    );
    await pool.query(
      `INSERT INTO ctf.agent_sessions(id,game_id,ordinal,agent_model,agent_effort,system_prompt)
       VALUES($1,$1,1,'synthetic-agent','medium','')`,
      [unknownId],
    );
    const unknownLease = (await claimSession(unknownId, unknownId, owner)).lease;
    const uncertain = await dispatchAsyncCommand({
      gameId: unknownId,
      sessionId: unknownId,
      lease: unknownLease,
      toolCallId: "call-uncertain",
      command: "curl --data-binary @/tmp/flag.txt",
      generation: 0,
    });
    assert.equal(
      await receiveFlagSubmission({
        token: uncertain.submissionToken!,
        value: secret,
      }),
      "accepted",
    );
    await completeAsyncCommand({
      dispatchId: uncertain.id,
      gameId: unknownId,
      sessionId: unknownId,
      messages: [],
      outcome: "unknown",
      output: "Execution status is unknown after interruption.",
    });
    assert.equal(
      (await pool.query("SELECT status FROM ctf.games WHERE id=$1", [unknownId])).rows[0].status,
      "active",
    );
    assert.equal(
      (
        await pool.query("SELECT count(*)::int AS n FROM ctf.finalization_jobs WHERE game_id=$1", [
          unknownId,
        ])
      ).rows[0].n,
      0,
    );

    // The Sprite boundary: refuse creation after admission and accept deletes of known Sprites.
    const created: string[] = [];
    const deleted: string[] = [];
    t.mock.method(SpritesClient.prototype, "createSprite", async (name: string) => {
      assert.match(name, /^ctf-[0-9a-f-]{36}$/);
      created.push(name);
      throw new Error("integration Sprite creation refused");
    });
    t.mock.method(SpritesClient.prototype, "deleteSprite", async (name: string) => {
      assert.ok(name === `ctf-${unknownId}` || created.includes(name), `Unexpected ${name}`);
      deleted.push(name);
    });
    t.mock.method(globalThis, "fetch", async () => {
      throw new Error("No live HTTP in integration tests");
    });
    const { startGame } = await import("../../lib/games");
    const unknownRun = async () =>
      (
        await pool.query(
          `SELECT g.status,g.submitted_flag_correct,r.promoted_at,
             (SELECT count(*)::int FROM ctf.finalization_jobs j WHERE j.game_id=g.id) AS jobs
           FROM ctf.games g JOIN ctf.flag_submissions r ON r.game_id=g.id WHERE g.id=$1`,
          [unknownId],
        )
      ).rows[0];
    // A receipt run whose response still holds its lease may yet drain, so it is not replaced.
    await assert.rejects(startGame(owner), { status: 409 });
    assert.deepEqual(created, []);
    assert.deepEqual(await unknownRun(), {
      status: "active",
      submitted_flag_correct: null,
      promoted_at: null,
      jobs: 0,
    });
    // Once that response has ended with the uploader unknown, nothing can promote the receipt, so a
    // new run replaces it instead of waiting for the 24-hour sweep.
    await releaseSessionLease(unknownId, unknownId, unknownLease);
    await assert.rejects(startGame(owner), /integration Sprite creation refused/);
    assert.equal(created.length, 1);
    assert.deepEqual(await unknownRun(), {
      status: "ended",
      submitted_flag_correct: null,
      promoted_at: null,
      jobs: 0,
    });
  },
);
