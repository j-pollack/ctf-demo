import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import { Pool } from "pg";
import { closePool } from "./postgres";
import { persistTranscriptEvidence } from "../../lib/transcript-evidence";

const parentURL = new URL(process.env.CTF_INTEGRATION_DATABASE_URL ?? "http://missing");
assert.equal(parentURL.hostname, "127.0.0.1");
assert.match(parentURL.pathname, /^\/ctf_integration_[a-f0-9]{32}$/);
const databaseName = `ctf_query_${randomUUID().replaceAll("-", "")}`;
const adminURL = new URL(parentURL);
adminURL.pathname = "/postgres";
const testURL = new URL(parentURL);
testURL.pathname = `/${databaseName}`;

test(
  "frozen SQL projection and canonical read pages enforce source and owner policy",
  { timeout: 60_000 },
  async () => {
    const admin = new Pool({ connectionString: adminURL.toString() });
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const pool = new Pool({
      connectionString: testURL.toString(),
      options: "-c search_path=ctf,public",
    });
    (globalThis as typeof globalThis & { ctfPool?: Pool }).ctfPool = pool;
    try {
      for (const file of [
        "../../db/schema.sql",
        ...[
          "002-dollar-seasons",
          "003-monitor-reasoning",
          "005-estimated-settlement",
          "006-system-prompt",
          "007-inference-game-index",
          "008-block-ends-run",
          "009-monitor-choice",
          "010-control-monitor",
          "011-agent-effort",
          "012-new-run",
          "013-agent-sessions",
          "015-transcript-evidence",
          "021-game-rules",
        ].map((name) => `../../db/migrations/${name}.sql`),
      ])
        await pool.query(await readFile(new URL(file, import.meta.url), "utf8"));
      const { captureCommittedMonitorSnapshot } = await import("../../lib/monitor-snapshot");
      const { createTranscriptInvestigationTools } = await import("../../lib/transcript-query");
      const { committedObservationRef } = await import("../../lib/transcript-query-projection");
      const { monitorSessionAlias } = await import("../../lib/monitor-tools");
      const owner = randomUUID();
      const target = randomUUID();
      const history = randomUUID();
      const foreign = randomUUID();
      const insert = async (id: string, ownerId: string, reasoning: boolean) => {
        await pool.query(
          `INSERT INTO ctf.games(id,owner_id,sprite_name,secret_hash,agent_model,monitor_model,monitor_version,token_budget,monitor_reasoning)
         VALUES($1,$2,$3,'hash','agent','monitor','v1',100,$4)`,
          [id, ownerId, `query-${id}`, reasoning],
        );
        await pool.query(
          `INSERT INTO ctf.agent_sessions(id,game_id,ordinal,agent_model,agent_effort,system_prompt,messages)
         VALUES($1,$1,1,'agent','medium','private system', '[]'::jsonb)`,
          [id],
        );
      };
      const write = async (id: string, messages: Message[], revision: number) => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await persistTranscriptEvidence(client, {
            gameId: id,
            sessionId: id,
            runRevision: revision,
            messages,
          });
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      };
      const user = (content: string): Message => ({ role: "user", content, timestamp: 1 });
      await insert(target, owner, false);
      await insert(history, owner, true);
      await insert(foreign, randomUUID(), true);
      await write(
        target,
        [
          { role: "system", content: "hidden target prompt", timestamp: 1 },
          user("target observation"),
          ...Array.from({ length: 61 }, (_, index) =>
            user(index === 48 ? "x".repeat(3_000) : `target history message ${index}`),
          ),
        ],
        1,
      );
      const privateThinking = {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private reasoning marker" },
          { type: "text", text: "public note" },
        ],
        timestamp: 1,
      } as Message;
      await write(history, [user("old clue"), privateThinking], 1);
      await write(history, [user("old clue"), privateThinking, user("flag read succeeded")], 2);
      await write(history, [user("repair removed clue")], 3);
      await write(history, [], 4);
      await write(foreign, [user("foreign private phrase")], 1);
      const snapshot = await captureCommittedMonitorSnapshot({
        gameId: target,
        sessionId: target,
        epoch: 1,
        targetVersion: 1,
      });
      const pages: unknown[] = [];
      const failures: unknown[] = [];
      const tools = await createTranscriptInvestigationTools(snapshot, target, {
        includeReasoning: true,
        signal: new AbortController().signal,
        onPage: (rows) => pages.push(...rows),
        onFatal: (error) => failures.push(error),
      });
      const call = async (name: string, args: unknown) => {
        const tool = tools.piTools.find((item) => item.name === name);
        assert.ok(tool, name);
        const response = await tool.execute(randomUUID(), args as never, undefined, undefined);
        const content = response.content[0];
        assert.equal(content?.type, "text");
        return JSON.parse(content.text);
      };
      const validationTools = await createTranscriptInvestigationTools(snapshot, target, {
        includeReasoning: false,
        signal: new AbortController().signal,
        onPage: () => {},
        onFatal: (error) => failures.push(error),
      });
      const validateCall = async (name: string, args: unknown) => {
        const tool = validationTools.piTools.find((item) => item.name === name);
        assert.ok(tool);
        const response = await tool.execute(randomUUID(), args as never, undefined, undefined);
        assert.equal(response.content[0]?.type, "text");
        return JSON.parse(response.content[0].text);
      };
      assert.deepEqual(await validateCall("query_transcripts", { sql: 42 }), {
        ok: false,
        error: "Invalid query_transcripts arguments.",
      });
      assert.deepEqual(await validateCall("read_transcript", { sessionId: 42 }), {
        ok: false,
        error: "Invalid read_transcript arguments.",
      });
      assert.equal(
        (await validateCall("query_transcripts", { sql: "SELECT count(*) AS n FROM sessions" }))
          .rows[0].n,
        2,
      );
      assert.equal(validationTools.retrievalCalls, 3);
      await validationTools.dispose();
      assert.equal(tools.initialEvidence.scope.observationCount, 5);
      assert.equal(tools.initialEvidence.scope.sessionCount, 2);
      assert.ok(
        Buffer.byteLength(JSON.stringify(tools.initialEvidence.currentTranscript), "utf8") <=
          8 * 1024,
      );
      assert.ok(tools.initialEvidence.currentTranscript.length < 63);
      assert.doesNotMatch(JSON.stringify(tools.initialEvidence), new RegExp(owner));
      assert.doesNotMatch(JSON.stringify(tools.initialEvidence), /hidden target prompt/);
      const searched = await call("query_transcripts", {
        sql: "WITH hits AS (SELECT session_id,observation_ref,text FROM messages WHERE text LIKE '%flag read%') SELECT h.session_id,h.observation_ref,h.text FROM hits h JOIN sessions s ON s.session_id=h.session_id",
      });
      assert.equal(searched.ok, true);
      assert.equal(searched.rows.length, 1);
      assert.equal(searched.citationEligible, false);
      assert.equal(pages.length, 0, "SQL rows must not become citation evidence");
      const forged = await call("query_transcripts", {
        sql: "SELECT 's_forged' AS session_id,'o_forged' AS observation_ref,'flag read succeeded' AS text",
      });
      assert.equal(forged.ok, true);
      assert.equal(pages.length, 0);
      const forgedRead = await call("read_transcript", {
        sessionId: forged.rows[0].session_id,
        observationRef: forged.rows[0].observation_ref,
      });
      assert.deepEqual(forgedRead, { ok: false, error: "Unknown evidence session." });
      const reasoningSearch = await call("query_transcripts", {
        sql: "SELECT text FROM messages WHERE text LIKE '%private reasoning marker%'",
      });
      assert.deepEqual(reasoningSearch.rows, [], "target reasoning policy hides source thinking");
      const historical = await call("read_transcript", {
        sessionId: searched.rows[0].session_id,
        observationRef: searched.rows[0].observation_ref,
      });
      assert.equal(historical.ok, true);
      assert.ok(
        historical.rows.some((row: { text: string }) => row.text.includes("flag read succeeded")),
      );
      assert.ok(
        historical.rows.every((row: { ref: string }) =>
          row.ref.includes(searched.rows[0].observation_ref),
        ),
      );
      assert.equal(pages.length, historical.rows.length);
      const latest = await call("read_transcript", {
        sessionId: monitorSessionAlias(snapshot, history),
      });
      assert.equal(latest.ok, true);
      assert.equal(latest.rows.length, 0, "deletion-only observation is still readable");
      const targetPage = await call("read_transcript", {
        sessionId: monitorSessionAlias(snapshot, target),
      });
      assert.equal(targetPage.ok, true);
      assert.ok(targetPage.rows.length > 0 && targetPage.rows.length <= 50);
      assert.ok(targetPage.nextCursor);
      let targetCount = targetPage.rows.length;
      let targetCursor = targetPage.nextCursor;
      while (targetCursor) {
        const next = await call("read_transcript", {
          sessionId: monitorSessionAlias(snapshot, target),
          cursor: targetCursor,
        });
        assert.equal(next.ok, true);
        assert.ok(
          next.rows.every((row: { ref: string }) =>
            row.ref.includes(tools.initialEvidence.targetObservationRef),
          ),
        );
        targetCount += next.rows.length;
        targetCursor = next.nextCursor;
      }
      assert.equal(targetCount, 63);
      const fixedSnapshot = {
        ...snapshot,
        snapshotId: "12000000-0000-4000-8000-000000000000",
      };
      const canonicalTools = await createTranscriptInvestigationTools(fixedSnapshot, target, {
        includeReasoning: false,
        signal: new AbortController().signal,
        onPage: () => {},
        onFatal: (error) => failures.push(error),
      });
      const canonicalCall = async (args: {
        sessionId: string;
        observationRef?: string;
        cursor?: string;
      }) => {
        const response = await canonicalTools.piTools
          .find((tool) => tool.name === "read_transcript")!
          .execute(randomUUID(), args, undefined, undefined);
        assert.equal(response.content[0]?.type, "text");
        return JSON.parse(response.content[0].text);
      };
      const fixedAlias = monitorSessionAlias(fixedSnapshot, target);
      const first = await canonicalCall({ sessionId: fixedAlias });
      const canonicalRows = [...first.rows];
      let nextCursor = first.nextCursor;
      while (nextCursor) {
        const next = await canonicalCall({ sessionId: fixedAlias, cursor: nextCursor });
        canonicalRows.push(...next.rows);
        nextCursor = next.nextCursor;
      }
      const expectedRef = (
        row: { sessionId: string; index: number; chunkCount: number; chunkIndex: number },
        observationRef: string,
      ) =>
        `msg:${fixedSnapshot.snapshotId}:${row.sessionId}:${observationRef}:${row.index}${row.chunkCount > 1 ? `#${row.chunkIndex}` : ""}`;
      for (const row of canonicalRows)
        assert.equal(row.ref, expectedRef(row, first.observationRef));
      for (const index of [1, 12, 50]) assert.ok(canonicalRows.some((row) => row.index === index));
      assert.deepEqual(
        canonicalRows.filter((row) => row.index === 50).map((row) => row.chunkIndex),
        [0, 1],
      );
      for (const row of canonicalTools.initialEvidence.currentTranscript) {
        assert.equal(
          row.ref,
          expectedRef(row, canonicalTools.initialEvidence.targetObservationRef),
        );
        assert.ok(canonicalRows.some((readRow) => readRow.ref === row.ref));
      }
      const initialCollisionSnapshot = {
        ...snapshot,
        snapshotId: "50000000-0000-4000-8000-000000000000",
      };
      const initialCollisionTools = await createTranscriptInvestigationTools(
        initialCollisionSnapshot,
        target,
        {
          includeReasoning: false,
          signal: new AbortController().signal,
          onPage: () => {},
          onFatal: (error) => failures.push(error),
        },
      );
      const initialCollisionRows = initialCollisionTools.initialEvidence.currentTranscript.filter(
        (row) => row.index === 50,
      );
      assert.deepEqual(
        initialCollisionRows.map((row) => row.chunkIndex),
        [0, 1],
      );
      for (const row of initialCollisionRows)
        assert.equal(
          row.ref,
          `msg:${initialCollisionSnapshot.snapshotId}:${row.sessionId}:${initialCollisionTools.initialEvidence.targetObservationRef}:50#${row.chunkIndex}`,
        );
      await initialCollisionTools.dispose();
      const oldAlias = monitorSessionAlias(fixedSnapshot, history);
      const oldObservation = await canonicalCall({
        sessionId: oldAlias,
        observationRef: committedObservationRef(fixedSnapshot, history, 2),
      });
      assert.equal(oldObservation.ok, true);
      for (const row of oldObservation.rows)
        assert.equal(row.ref, expectedRef(row, oldObservation.observationRef));
      const repairedHistory = await canonicalCall({
        sessionId: oldAlias,
        observationRef: committedObservationRef(fixedSnapshot, history, 3),
      });
      assert.equal(repairedHistory.ok, true);
      for (const row of repairedHistory.rows)
        assert.equal(row.ref, expectedRef(row, repairedHistory.observationRef));
      await canonicalTools.dispose();
      await write(history, [user("post-capture private version")], 5);
      const future = await call("query_transcripts", {
        sql: "SELECT text FROM messages WHERE text LIKE '%post-capture%'",
      });
      assert.deepEqual(future.rows, [], "newer observations stay outside the frozen ceiling");
      const denied = await call("query_transcripts", {
        sql: "SELECT text FROM messages WHERE text LIKE '%foreign private%'",
      });
      assert.deepEqual(denied.rows, []);
      const badCursor = await call("query_transcripts", {
        sql: "SELECT session_id FROM sessions",
        cursor: "bad",
      });
      assert.deepEqual(badCursor, { ok: false, error: "Invalid cursor." });
      const badSql = await call("query_transcripts", { sql: "SELEC session_id FROM sessions" });
      assert.equal(badSql.ok, false);
      assert.equal(
        (await call("query_transcripts", { sql: "SELECT count(*) AS n FROM sessions" })).rows[0].n,
        2,
      );
      assert.equal(failures.length, 0);
      const queryStartedAt = Date.now();
      const pending = call("query_transcripts", {
        sql: "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n) SELECT sum(x) FROM n",
      }).then(
        () => null,
        (error: unknown) => error,
      );
      await new Promise((resolve) => setTimeout(resolve, 250));
      await pool.query("UPDATE ctf.games SET owner_id=$2 WHERE id=$1", [history, randomUUID()]);
      const revoked = await pending;
      assert.match(String(revoked), /no longer available/);
      assert.ok(Date.now() - queryStartedAt >= 800, "revocation occurs while SQLite is running");
      assert.equal(failures.length, 1);
      await tools.dispose();
      const emptyHistory = randomUUID();
      await insert(emptyHistory, owner, false);
      await pool.query(
        `INSERT INTO ctf.transcript_observations
       (session_id,version,epoch,run_revision,message_count,changed_start,changed_indices,
        changed_messages,search_public,search_with_reasoning,provenance)
       SELECT $1,n,1,0,0,0,ARRAY[]::integer[],'[]'::jsonb,
         ARRAY[]::text[],ARRAY[]::text[],'runtime'
       FROM generate_series(1,20001) AS n`,
        [emptyHistory],
      );
      const oversizedSnapshot = await captureCommittedMonitorSnapshot({
        gameId: target,
        sessionId: target,
        epoch: 1,
        targetVersion: 1,
      });
      const budgetFailures: unknown[] = [];
      await assert.rejects(
        createTranscriptInvestigationTools(oversizedSnapshot, target, {
          includeReasoning: false,
          signal: new AbortController().signal,
          onPage: () => {},
          onFatal: (error) => budgetFailures.push(error),
        }),
        /query export limit/,
      );
      assert.equal(
        budgetFailures.length,
        1,
        "deletion-only versions must count before payload export",
      );
    } finally {
      await closePool(pool);
      delete (globalThis as typeof globalThis & { ctfPool?: Pool }).ctfPool;
      await admin.query(`DROP DATABASE ${databaseName}`);
      await admin.end();
    }
  },
);
