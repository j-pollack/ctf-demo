import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Pool } from "pg";

const base = new URL(process.env.CTF_INTEGRATION_DATABASE_URL ?? "http://missing");
assert.equal(process.env.NODE_ENV, "test", "Use npm run test:integration");
assert.equal(base.hostname, "127.0.0.1");
assert.match(base.pathname, /^\/ctf_integration_[a-f0-9]{32}$/);
const database = `ctf_integration_${randomUUID().replaceAll("-", "")}`;
const adminUrl = new URL(base);
adminUrl.pathname = "/postgres";

test(
  "HTTP receipts bind to a live dispatch and promote only after durable completion",
  { timeout: 90_000 },
  async (t) => {
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
      "migrations/018-monitor-ready.sql",
      "migrations/019-session-stop.sql",
    ])
      await pool.query(await readFile(new URL(`../../db/${file}`, import.meta.url), "utf8"));
    const legacyId = randomUUID();
    const legacyMessages = [{ role: "user", content: "legacy evidence" }];
    await pool.query(
      `INSERT INTO ctf.games(id,owner_id,sprite_name,secret_hash,agent_model,monitor_model,
        monitor_version,status,token_budget,agent_effort,system_prompt,monitor_mode,
        messages,tokens_used,blocks,reserved_microdollars)
       VALUES($1,'legacy-owner',$2,'legacy-hash','agent','monitor','legacy','active',
         1000,'medium','','async',$3,37,2,19)`,
      [legacyId, `sprite-${legacyId}`, JSON.stringify(legacyMessages)],
    );
    const migration = await readFile(
      new URL("../../db/migrations/020-http-flag-submission.sql", import.meta.url),
      "utf8",
    );
    await pool.query(migration);
    await pool.query(migration);
    const rules = await readFile(
      new URL("../../db/migrations/021-game-rules.sql", import.meta.url),
      "utf8",
    );
    await pool.query(rules);
    await pool.query(rules);
    const returned = await readFile(
      new URL("../../db/migrations/024-command-returned.sql", import.meta.url),
      "utf8",
    );
    await pool.query(returned);
    await pool.query(
      await readFile(
        new URL("../../db/migrations/025-jailbreak-catch.sql", import.meta.url),
        "utf8",
      ),
    );
    await pool.query(
      await readFile(
        new URL("../../db/migrations/026-investigator-verdicts.sql", import.meta.url),
        "utf8",
      ),
    );
    await pool.query(
      await readFile(
        new URL("../../db/migrations/027-review-prompt-hash.sql", import.meta.url),
        "utf8",
      ),
    );
    await pool.query(
      await readFile(
        new URL("../../db/migrations/028-review-continuations.sql", import.meta.url),
        "utf8",
      ),
    );
    const legacy = (
      await pool.query(
        `SELECT submission_transport,messages,tokens_used,blocks,reserved_microdollars
       FROM ctf.games WHERE id=$1`,
        [legacyId],
      )
    ).rows[0];
    assert.deepEqual(legacy, {
      submission_transport: "tool",
      messages: legacyMessages,
      tokens_used: 37,
      blocks: 2,
      reserved_microdollars: "19",
    });

    process.env.BETTER_AUTH_SECRET = "integration-only-secret-long-enough-for-better-auth";
    process.env.BETTER_AUTH_URL = "http://localhost";
    process.env.TRIPWIRE_COOKIE_PREFIX = "ctf-integration";
    const { auth } = await import("../../lib/auth");
    const { getMigrations } = await import("better-auth/db/migration");
    await (await getMigrations(auth.options)).runMigrations();
    const signedIn = await auth.api.signInAnonymous({ returnHeaders: true });
    const ownerId = signedIn.response!.user.id;
    await pool.query(`UPDATE ctf."user" SET "isAnonymous"=false WHERE id=$1`, [ownerId]);
    const ownerCookie = signedIn.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const owner = await auth.api.getSession({ headers: new Headers({ cookie: ownerCookie }) });
    assert.equal(owner?.user.id, ownerId);
    assert.equal(owner?.user.isAnonymous, false);

    const { hashSecret } = await import("../../lib/policy");
    const { hashSubmissionToken, receiveFlagSubmission, promoteHttpSubmission } =
      await import("../../lib/flag-submissions");
    const { transaction } = await import("../../lib/games");
    const { POST } = await import("../../app/v1/end/[[...token]]/route");
    const gameId = randomUUID();
    const sessionId = randomUUID();
    const operationId = randomUUID();
    const lease = randomUUID();
    const token = randomBytes(32).toString("base64url");
    const flag = `flag{${randomBytes(24).toString("base64url")}}`;
    await pool.query(
      `INSERT INTO ctf.games(id,owner_id,sprite_name,secret_hash,agent_model,monitor_model,
      monitor_version,status,token_budget,agent_effort,system_prompt,monitor_mode,submission_transport)
     VALUES($1,$2,$3,$4,'agent','monitor','version','active',1000,'medium','','async','http')`,
      [gameId, ownerId, `sprite-${gameId}`, hashSecret(flag)],
    );
    await pool.query(
      `INSERT INTO ctf.agent_sessions(id,game_id,ordinal,agent_model,agent_effort,system_prompt,lease,lease_until)
     VALUES($1,$2,1,'agent','medium','',$3,now()+interval '1 minute')`,
      [sessionId, gameId, lease],
    );
    await pool.query(
      `INSERT INTO ctf.sprite_operations(id,sprite_name,game_id,session_id,tool_call_id,kind,command,
      execution_generation,submission_token_hash,originating_lease)
     VALUES($1,$2,$3,$4,'call','command','curl',0,$5,$6)`,
      [operationId, `sprite-${gameId}`, gameId, sessionId, hashSubmissionToken(token), lease],
    );

    const endpoint = "https://flags.integration.test/v1/end";
    const post = (body: string, capability = token, headers: Record<string, string> = {}) =>
      POST(
        new Request(`${endpoint}/${capability}`, {
          method: "POST",
          headers: { Host: "flags.integration.test", ...headers },
          body,
        }),
        { params: Promise.resolve({ token: [capability] }) },
      );

    const missing = await post(flag, "invalid-token");
    assert.equal(missing.status, 401);
    assert.equal(missing.headers.get("cache-control"), "no-store");
    assert.equal(
      (
        await POST(
          new Request(endpoint, {
            method: "POST",
            headers: { Host: "flags.integration.test", Cookie: ownerCookie },
            body: flag,
          }),
          { params: Promise.resolve({}) },
        )
      ).status,
      401,
    );
    assert.equal(
      (await pool.query("SELECT count(*)::int AS n FROM ctf.flag_submissions")).rows[0].n,
      0,
    );
    assert.equal((await post(flag, token, { Origin: "https://app.example" })).status, 400);
    assert.equal((await post("", token)).status, 400);
    assert.equal(
      (await pool.query("SELECT count(*)::int AS n FROM ctf.flag_submissions")).rows[0].n,
      0,
    );
    await pool.query(
      "UPDATE ctf.agent_sessions SET lease_until=now()-interval '1 second' WHERE id=$1",
      [sessionId],
    );
    assert.equal((await post(flag)).status, 409);
    const replacementLease = randomUUID();
    await pool.query(
      "UPDATE ctf.agent_sessions SET lease=$2,lease_until=now()+interval '1 minute' WHERE id=$1",
      [sessionId, replacementLease],
    );
    assert.equal((await post(flag)).status, 409);
    await pool.query("UPDATE ctf.agent_sessions SET lease=$2,stop_requested_at=now() WHERE id=$1", [
      sessionId,
      lease,
    ]);
    assert.equal((await post(flag)).status, 409);
    await pool.query("UPDATE ctf.agent_sessions SET stop_requested_at=NULL WHERE id=$1", [
      sessionId,
    ]);
    await pool.query("UPDATE ctf.sprite_operations SET status='completed' WHERE id=$1", [
      operationId,
    ]);
    assert.equal((await post(flag)).status, 409);
    await pool.query("UPDATE ctf.sprite_operations SET status='running' WHERE id=$1", [
      operationId,
    ]);
    await pool.query(
      "UPDATE ctf.games SET execution_generation=execution_generation+1 WHERE id=$1",
      [gameId],
    );
    assert.equal((await post(flag)).status, 409);
    await pool.query(
      "UPDATE ctf.games SET execution_generation=execution_generation-1 WHERE id=$1",
      [gameId],
    );
    const [first, simultaneous] = await Promise.all([post(flag), post(flag)]);
    assert.equal(first.status, 202);
    assert.equal(simultaneous.status, 202);
    const ack = await first.text();
    assert.equal(ack.includes(flag), false);
    assert.equal((await post(flag)).status, 202);
    assert.equal((await post("wrong body")).status, 409);
    const receiptBefore = (
      await pool.query(
        "SELECT game_id,operation_id,body_hash,correct,accepted_at,promoted_at FROM ctf.flag_submissions WHERE game_id=$1",
        [gameId],
      )
    ).rows[0];
    await pool.query(migration);
    assert.deepEqual(
      (
        await pool.query(
          "SELECT game_id,operation_id,body_hash,correct,accepted_at,promoted_at FROM ctf.flag_submissions WHERE game_id=$1",
          [gameId],
        )
      ).rows[0],
      receiptBefore,
    );
    await assert.rejects(
      pool.query("UPDATE ctf.flag_submissions SET body_hash=$2 WHERE game_id=$1", [
        gameId,
        hashSecret("changed"),
      ]),
      /immutable/,
    );
    const competingToken = randomBytes(32).toString("base64url");
    await pool.query(
      `INSERT INTO ctf.sprite_operations(id,sprite_name,game_id,session_id,tool_call_id,kind,
      command,execution_generation,submission_token_hash,originating_lease)
     VALUES($1,$2,$3,$4,'competing','command','printf x',0,$5,$6)`,
      [
        randomUUID(),
        `sprite-${gameId}`,
        gameId,
        sessionId,
        hashSubmissionToken(competingToken),
        lease,
      ],
    );
    assert.equal((await post(flag, competingToken)).status, 409);
    await pool.query(
      "UPDATE ctf.sprite_operations SET status='completed',output='' WHERE game_id=$1 AND tool_call_id='competing'",
      [gameId],
    );
    assert.equal(
      (await pool.query("SELECT count(*)::int AS n FROM ctf.flag_submissions")).rows[0].n,
      1,
    );
    assert.equal(await transaction((client) => promoteHttpSubmission(client, gameId)), "pending");
    await pool.query(
      "UPDATE ctf.agent_sessions SET stop_requested_at=now(),lease_until=now()-interval '1 second' WHERE id=$1",
      [sessionId],
    );
    assert.equal((await post(flag)).status, 202);
    await pool.query(
      "UPDATE ctf.sprite_operations SET status='completed',output='',completed_at=now() WHERE id=$1",
      [operationId],
    );
    await pool.query(
      "UPDATE ctf.sprite_operations SET status='unknown' WHERE game_id=$1 AND tool_call_id='competing'",
      [gameId],
    );
    assert.equal(await transaction((client) => promoteHttpSubmission(client, gameId)), "pending");
    await pool.query(
      "UPDATE ctf.sprite_operations SET status='completed' WHERE game_id=$1 AND tool_call_id='competing'",
      [gameId],
    );
    assert.equal(await transaction((client) => promoteHttpSubmission(client, gameId)), "promoted");
    assert.equal(await transaction((client) => promoteHttpSubmission(client, gameId)), "none");
    const replay = await post(flag);
    assert.equal(replay.status, 202);
    assert.equal(await replay.text(), ack);
    assert.equal((await post("wrong body")).status, 409);
    const run = (
      await pool.query("SELECT status,submitted_flag_correct FROM ctf.games WHERE id=$1", [gameId])
    ).rows[0];
    assert.deepEqual(run, { status: "finalizing", submitted_flag_correct: true });
    const events = (await pool.query("SELECT data FROM ctf.events WHERE game_id=$1", [gameId]))
      .rows;
    assert.equal(events.length, 1);
    assert.equal(events[0].data.submissionTransport, "http");
    assert.equal(JSON.stringify(events).includes(flag), false);
    assert.equal(
      (
        await pool.query("SELECT count(*)::int AS n FROM ctf.finalization_jobs WHERE game_id=$1", [
          gameId,
        ])
      ).rows[0].n,
      1,
    );
    assert.equal(await receiveFlagSubmission({ token, value: flag }), "accepted");
    await pool.query("UPDATE ctf.games SET status='caught' WHERE id=$1", [gameId]);
    assert.equal((await post(flag)).status, 202);
    assert.equal((await post("changed")).status, 409);
    await pool.query("UPDATE ctf.games SET status='exhausted' WHERE id=$1", [gameId]);
    assert.equal((await post(flag)).status, 202);

    const wrongGameId = randomUUID();
    const wrongSessionId = randomUUID();
    const wrongOperationId = randomUUID();
    const wrongLease = randomUUID();
    const wrongToken = randomBytes(32).toString("base64url");
    await pool.query(
      `INSERT INTO ctf.games(id,owner_id,sprite_name,secret_hash,agent_model,monitor_model,
        monitor_version,status,token_budget,agent_effort,system_prompt,monitor_mode,submission_transport)
       VALUES($1,$2,$3,$4,'agent','monitor','version','active',1000,'medium','','async','http')`,
      [wrongGameId, ownerId, `sprite-${wrongGameId}`, hashSecret(flag)],
    );
    await pool.query(
      `INSERT INTO ctf.agent_sessions(id,game_id,ordinal,agent_model,agent_effort,system_prompt,lease,lease_until)
       VALUES($1,$2,1,'agent','medium','',$3,now()+interval '1 minute')`,
      [wrongSessionId, wrongGameId, wrongLease],
    );
    await pool.query(
      `INSERT INTO ctf.sprite_operations(id,sprite_name,game_id,session_id,tool_call_id,kind,command,
        execution_generation,submission_token_hash,originating_lease)
       VALUES($1,$2,$3,$4,'wrong','command','curl',0,$5,$6)`,
      [
        wrongOperationId,
        `sprite-${wrongGameId}`,
        wrongGameId,
        wrongSessionId,
        hashSubmissionToken(wrongToken),
        wrongLease,
      ],
    );
    await assert.rejects(
      pool.query(
        "INSERT INTO ctf.flag_submissions(game_id,operation_id,body_hash,correct) VALUES($1,$2,$3,false)",
        [
          wrongGameId,
          (
            await pool.query(
              "SELECT id FROM ctf.sprite_operations WHERE game_id=$1 AND tool_call_id='competing'",
              [gameId],
            )
          ).rows[0].id,
          hashSecret("wrong body"),
        ],
      ),
      /foreign key constraint/,
    );
    const wrong = await post("wrong body", wrongToken);
    assert.equal(wrong.status, 202);
    assert.equal(await wrong.text(), ack);
    assert.equal((await post(flag, wrongToken)).status, 409);
    await pool.query("UPDATE ctf.sprite_operations SET status='completed',output='' WHERE id=$1", [
      wrongOperationId,
    ]);
    assert.equal(
      await transaction((client) => promoteHttpSubmission(client, wrongGameId)),
      "promoted",
    );
    assert.equal(
      (await pool.query("SELECT submitted_flag_correct FROM ctf.games WHERE id=$1", [wrongGameId]))
        .rows[0].submitted_flag_correct,
      false,
    );
  },
);
