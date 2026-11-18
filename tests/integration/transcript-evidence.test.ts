import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Pool } from "pg";
import type { Message } from "@earendil-works/pi-ai";
import {
  backfillTranscriptSearchText,
  persistTranscriptEvidence,
  reconstructTranscript,
} from "../../lib/transcript-evidence";

const parentURL = new URL(process.env.CTF_INTEGRATION_DATABASE_URL ?? "http://missing");
assert.equal(parentURL.hostname, "127.0.0.1");
assert.match(parentURL.pathname, /^\/ctf_integration_[a-f0-9]{32}$/);
const databaseName = `ctf_evidence_${randomUUID().replaceAll("-", "")}`;
const adminURL = new URL(parentURL);
adminURL.pathname = "/postgres";
const testURL = new URL(parentURL);
testURL.pathname = `/${databaseName}`;

test(
  "immutable transcript versions and owner-scoped literal search",
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
        ].map((name) => `../../db/migrations/${name}.sql`),
        "../../db/migrations/015-transcript-evidence.sql",
        "../../db/migrations/021-game-rules.sql",
      ])
        await pool.query(await readFile(new URL(file, import.meta.url), "utf8"));
      const migration = await readFile(
        new URL("../../db/migrations/015-transcript-evidence.sql", import.meta.url),
        "utf8",
      );
      await pool.query(migration);
      const { captureCommittedMonitorSnapshot } = await import("../../lib/monitor-snapshot");
      const { createTranscriptInvestigationTools } = await import("../../lib/transcript-query");
      const { evidenceMessages, monitorSessionAlias } = await import("../../lib/monitor-tools");
      const owner = randomUUID();
      const other = randomUUID();
      const insert = async (id: string, ownerId: string, messages: unknown[]) => {
        await pool.query(
          `INSERT INTO ctf.games(id,owner_id,sprite_name,secret_hash,agent_model,monitor_model,monitor_version,token_budget,monitor_reasoning)
         VALUES($1,$2,$3,'hash','agent','monitor','v1',100,true)`,
          [id, ownerId, `evidence-${id}`],
        );
        await pool.query(
          `INSERT INTO ctf.agent_sessions(id,game_id,ordinal,agent_model,agent_effort,system_prompt,messages)
         VALUES($1,$1,1,'agent','medium','hidden system',$2)`,
          [id, JSON.stringify(messages)],
        );
      };
      const target = randomUUID();
      const old = randomUUID();
      const foreign = randomUUID();
      const privateHistory = randomUUID();
      const reasoningHistory = randomUUID();
      const needle = "café_%/🧪";
      const reasoningMarker = "source reasoning clue";
      await insert(target, owner, [{ role: "user", content: "current", timestamp: 1 }]);
      await insert(old, owner, [{ role: "system", content: needle, timestamp: 1 }]);
      await insert(foreign, other, [{ role: "user", content: needle, timestamp: 1 }]);
      await insert(privateHistory, owner, [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: needle },
            { type: "text", text: "public observation" },
          ],
          timestamp: 1,
        },
      ]);
      await pool.query("UPDATE ctf.games SET monitor_reasoning=false WHERE id=$1", [
        privateHistory,
      ]);
      await insert(reasoningHistory, owner, [
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: reasoningMarker }],
          timestamp: 1,
        },
      ]);
      for (let i = 0; i < 105; i++)
        await insert(randomUUID(), owner, [{ role: "user", content: `decoy ${i}`, timestamp: 1 }]);
      await pool.query(migration);
      await backfillTranscriptSearchText(pool);
      assert.equal(
        (await pool.query("SELECT count(*)::int AS count FROM ctf.transcript_observations")).rows[0]
          .count,
        110,
      );
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const first = await persistTranscriptEvidence(client, {
          gameId: old,
          sessionId: old,
          runRevision: 1,
          messages: [
            { role: "system", content: needle, timestamp: 1 },
            { role: "user", content: `${"x".repeat(2_498)}${needle} right`, timestamp: 2 },
          ],
        });
        assert.deepEqual(first, { version: 2, epoch: 1, changed: true, appendOnly: true });
        // Live messages can carry undefined fields that stored JSON drops; that is not a rewrite.
        const appended = await persistTranscriptEvidence(client, {
          gameId: old,
          sessionId: old,
          runRevision: 1,
          messages: [
            { role: "system", content: needle, timestamp: 1, details: undefined },
            { role: "user", content: `${"x".repeat(2_498)}${needle} right`, timestamp: 2 },
            { role: "user", content: "next", timestamp: 3 },
          ] as Message[],
        });
        assert.deepEqual(appended, { version: 3, epoch: 1, changed: true, appendOnly: true });
        const repaired = await persistTranscriptEvidence(client, {
          gameId: old,
          sessionId: old,
          runRevision: 2,
          messages: [{ role: "user", content: "repaired away", timestamp: 3 }],
        });
        assert.deepEqual(repaired, { version: 4, epoch: 2, changed: true, appendOnly: false });
        await client.query("COMMIT");
        assert.equal((await reconstructTranscript(client, old, 2))[1].role, "user");
      } finally {
        client.release();
      }
      const beforeRerun = (
        await pool.query(
          `SELECT version::text,changed_messages,search_public,search_with_reasoning,observed_at
           FROM ctf.transcript_observations o WHERE session_id=$1 ORDER BY o.version`,
          [old],
        )
      ).rows;
      await pool.query(migration);
      await backfillTranscriptSearchText(pool);
      const afterRerun = (
        await pool.query(
          `SELECT version::text,changed_messages,search_public,search_with_reasoning,observed_at
           FROM ctf.transcript_observations o WHERE session_id=$1 ORDER BY o.version`,
          [old],
        )
      ).rows;
      assert.deepEqual(afterRerun, beforeRerun);
      assert.deepEqual(
        (
          await pool.query(
            "SELECT version::int FROM ctf.transcript_observations o WHERE session_id=$1 ORDER BY o.version",
            [old],
          )
        ).rows.map((row) => row.version),
        [1, 2, 3, 4],
      );
      const capturedSnapshot = await captureCommittedMonitorSnapshot({
        gameId: target,
        sessionId: target,
        epoch: 1,
        targetVersion: 1,
      });
      const snapshot = {
        ...capturedSnapshot,
        snapshotId: "12000000-0000-4000-8000-000000000000",
      };
      assert.equal(snapshot.searchableHistorySessions, 108);
      assert.equal(snapshot.omittedSessions, 0);
      const oldAlias = monitorSessionAlias(snapshot, old);
      assert.equal(
        evidenceMessages(
          snapshot,
          old,
          [{ role: "user", content: "uncommitted", timestamp: 1 }],
          false,
        )[0].ref,
        `msg:${snapshot.snapshotId}:${oldAlias}:0`,
      );
      const targetClient = await pool.connect();
      try {
        await targetClient.query("BEGIN");
        await persistTranscriptEvidence(targetClient, {
          gameId: target,
          sessionId: target,
          runRevision: 2,
          messages: [
            { role: "user", content: "current", timestamp: 1 },
            { role: "user", content: needle, timestamp: 2 },
          ],
        });
        await targetClient.query("COMMIT");
      } finally {
        targetClient.release();
      }
      const concurrentId = randomUUID();
      await insert(concurrentId, owner, []);
      const writes = await Promise.allSettled(
        Array.from({ length: 5 }, async (_, index) => {
          const connection = await pool.connect();
          try {
            await connection.query("BEGIN");
            await persistTranscriptEvidence(connection, {
              gameId: concurrentId,
              sessionId: concurrentId,
              runRevision: index,
              messages: [{ role: "user", content: `writer ${index}`, timestamp: index }],
            });
            await connection.query("COMMIT");
          } catch (error) {
            await connection.query("ROLLBACK");
            const detail =
              error && typeof error === "object" && "detail" in error ? String(error.detail) : "";
            throw new Error(`Concurrent evidence persistence failed: ${detail}`, { cause: error });
          } finally {
            connection.release();
          }
        }),
      );
      assert.deepEqual(
        writes.filter((result) => result.status === "rejected"),
        [],
      );
      const versions = await pool.query<{ version: string }>(
        "SELECT version::text FROM ctf.transcript_observations o WHERE session_id=$1 ORDER BY o.version",
        [concurrentId],
      );
      assert.deepEqual(
        versions.rows.map((row) => Number(row.version)),
        [1, 2, 3, 4, 5],
      );
      for (let index = 5; index < 12; index++) {
        const connection = await pool.connect();
        try {
          await connection.query("BEGIN");
          await persistTranscriptEvidence(connection, {
            gameId: concurrentId,
            sessionId: concurrentId,
            runRevision: index,
            messages: [{ role: "user", content: `writer ${index}`, timestamp: index }],
          });
          await connection.query("COMMIT");
        } catch (error) {
          await connection.query("ROLLBACK");
          throw error;
        } finally {
          connection.release();
        }
      }
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM ctf.transcript_observations WHERE session_id=$1",
            [concurrentId],
          )
        ).rows[0].count,
        12,
      );
      const emptyClient = await pool.connect();
      try {
        await emptyClient.query("BEGIN");
        const truncated = await persistTranscriptEvidence(emptyClient, {
          gameId: concurrentId,
          sessionId: concurrentId,
          runRevision: 12,
          messages: [],
        });
        assert.equal(truncated.appendOnly, false);
        await emptyClient.query("COMMIT");
        const {
          rows: [empty],
        } = await emptyClient.query<{
          publicCount: number;
          reasoningCount: number;
        }>(
          `SELECT cardinality(search_public) AS "publicCount",
             cardinality(search_with_reasoning) AS "reasoningCount"
           FROM ctf.transcript_observations
           WHERE session_id=$1 AND version=$2`,
          [concurrentId, truncated.version],
        );
        assert.deepEqual(empty, { publicCount: 0, reasoningCount: 0 });
      } finally {
        emptyClient.release();
      }
      // Search text stored before submit calls were hidden is cleared and re-rendered without them.
      const submitted = randomUUID();
      await insert(submitted, owner, [
        { role: "user", content: "fix the bug", timestamp: 1 },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Submitting now." },
            { type: "toolCall", id: "s1", name: "submit", arguments: { value: "flag{leak}" } },
          ],
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "s1",
          toolName: "submit",
          content: [{ type: "text", text: "Submitted." }],
          isError: false,
          timestamp: 3,
        },
      ]);
      await pool.query(migration);
      const stale = [
        "fix the bug",
        'Submitting now.\n[tool call submit id=s1] {"value":"flag{leak}"}',
        "Submitted.",
      ];
      await pool.query(
        `UPDATE ctf.transcript_observations SET search_public=$2,search_with_reasoning=$2
         WHERE session_id=$1`,
        [submitted, stale],
      );
      const hideSubmit = await readFile(
        new URL("../../db/migrations/016-hide-submit-from-monitor.sql", import.meta.url),
        "utf8",
      );
      await pool.query(hideSubmit);
      await backfillTranscriptSearchText(pool);
      const searchRows = async () =>
        (
          await pool.query(
            `SELECT search_public AS "searchPublic",search_with_reasoning AS "searchReasoning"
             FROM ctf.transcript_observations WHERE session_id=$1`,
            [submitted],
          )
        ).rows;
      const rerendered = await searchRows();
      assert.deepEqual(rerendered, [
        {
          searchPublic: ["fix the bug", "Submitting now.", null],
          searchReasoning: ["fix the bug", "Submitting now.", null],
        },
      ]);
      await pool.query(hideSubmit);
      assert.deepEqual(await searchRows(), rerendered, "re-running the migration is a no-op");

      // Run rules: the isolation flag narrows the manifest, and with it every retrieval tool.
      const scoped = randomUUID();
      const isolatedRun = randomUUID();
      const siblingSession = randomUUID();
      const openRun = randomUUID();
      const siblingLiteral = "sibling-literal-in-the-same-run";
      const otherRunLiteral = "other-run-literal-of-the-same-owner";
      const addRun = async (id: string, isolation: boolean, text: string, ordinal = 1) => {
        await pool.query(
          `INSERT INTO ctf.games(id,owner_id,sprite_name,secret_hash,agent_model,monitor_model,monitor_version,token_budget,monitor_reasoning,monitor_isolation)
           VALUES($1,$2,$3,'hash','agent','monitor','v1',100,true,$4)`,
          [id, scoped, `evidence-${id}`, isolation],
        );
        await pool.query(
          `INSERT INTO ctf.agent_sessions(id,game_id,ordinal,agent_model,agent_effort,system_prompt,messages)
           VALUES($1,$1,$2,'agent','medium','hidden system',$3)`,
          [id, ordinal, JSON.stringify([{ role: "user", content: text, timestamp: 1 }])],
        );
      };
      await addRun(isolatedRun, true, "isolated target");
      await addRun(openRun, false, otherRunLiteral);
      await pool.query(
        `INSERT INTO ctf.agent_sessions(id,game_id,ordinal,agent_model,agent_effort,system_prompt,messages)
         VALUES($1,$2,2,'agent','medium','hidden system',$3)`,
        [
          siblingSession,
          isolatedRun,
          JSON.stringify([{ role: "user", content: siblingLiteral, timestamp: 1 }]),
        ],
      );
      await pool.query(migration);
      await backfillTranscriptSearchText(pool);
      const capture = async (gameId: string) =>
        captureCommittedMonitorSnapshot({ gameId, sessionId: gameId, epoch: 1, targetVersion: 1 });
      const listed = (snapshot: Awaited<ReturnType<typeof capture>>) =>
        (snapshot.evidenceManifest ?? []).map((entry) => entry.sessionId).sort();

      const open = await capture(openRun);
      assert.deepEqual(
        listed(open),
        [isolatedRun, openRun, siblingSession].sort(),
        "M1: without isolation the manifest lists every session of the owner across runs",
      );
      assert.equal(open.searchableHistorySessions, 2);

      const isolated = await capture(isolatedRun);
      assert.deepEqual(
        listed(isolated),
        [isolatedRun, siblingSession].sort(),
        "M2: with isolation the manifest lists only the run's own sessions",
      );
      assert.equal(isolated.searchableHistorySessions, 1);
      const literalHits = async (
        snapshot: Awaited<ReturnType<typeof capture>>,
        literal: string,
      ) => {
        const tools = await createTranscriptInvestigationTools(snapshot, snapshot.targetSessionId, {
          includeReasoning: false,
          signal: new AbortController().signal,
          onPage: () => {},
          onFatal: (error) => assert.fail(String(error)),
        });
        try {
          const tool = tools.piTools.find((item) => item.name === "query_transcripts");
          assert.ok(tool);
          const response = await tool.execute(
            randomUUID(),
            { sql: `SELECT count(*) AS n FROM messages WHERE text LIKE '%${literal}%'` } as never,
            undefined,
            undefined,
          );
          const content = response.content[0];
          assert.equal(content?.type, "text");
          return JSON.parse(content.text).rows[0].n as number;
        } finally {
          await tools.dispose();
        }
      };
      assert.equal(
        await literalHits(isolated, otherRunLiteral),
        0,
        "M3: another run's text of the same owner is not retrievable",
      );
      assert.equal(await literalHits(isolated, siblingLiteral), 1);
      assert.equal(await literalHits(open, otherRunLiteral), 1);
    } finally {
      assert.equal(
        (await import("../../lib/db")).db,
        pool,
        "Evidence retrieval must use the test pool",
      );
      await pool.end();
      await admin.query(`DROP DATABASE ${databaseName}`);
      await admin.end();
    }
  },
);
