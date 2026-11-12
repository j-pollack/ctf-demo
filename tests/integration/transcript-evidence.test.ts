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
import { stripInheritedHiddenReasoning } from "../../lib/fork-transcript";

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
      ])
        await pool.query(await readFile(new URL(file, import.meta.url), "utf8"));
      const migration = await readFile(
        new URL("../../db/migrations/015-transcript-evidence.sql", import.meta.url),
        "utf8",
      );
      await pool.query(migration);
      const { captureCommittedMonitorSnapshot } = await import("../../lib/monitor-snapshot");
      const { searchCommittedTranscripts, readCommittedTranscript, createCommittedEvidenceTools } =
        await import("../../lib/transcript-search");
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
      const unmaterialized = await captureCommittedMonitorSnapshot({
        gameId: target,
        sessionId: target,
        epoch: 1,
        targetVersion: 1,
      });
      await assert.rejects(
        searchCommittedTranscripts(unmaterialized, "current", false),
        /search text is unavailable/,
      );
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
        const repaired = await persistTranscriptEvidence(client, {
          gameId: old,
          sessionId: old,
          runRevision: 2,
          messages: [{ role: "user", content: "repaired away", timestamp: 3 }],
        });
        assert.deepEqual(repaired, { version: 3, epoch: 2, changed: true, appendOnly: false });
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
        [1, 2, 3],
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
      const hits = await searchCommittedTranscripts(snapshot, needle, false);
      assert.ok(
        hits.some(
          (hit) => hit.sessionId === monitorSessionAlias(snapshot, old) && hit.version === 2,
        ),
      );
      assert.equal(hits.length, 1, "system and foreign-owner text must not count");
      const tools = createCommittedEvidenceTools(
        snapshot,
        false,
        () => {},
        () => {},
      );
      const call = async (index: number, args: unknown) => {
        const result = await tools.piTools[index].execute(
          randomUUID(),
          args as never,
          undefined,
          undefined,
          {} as never,
        );
        const content = result.content[0];
        assert.equal(content?.type, "text");
        return JSON.parse(content.text);
      };
      const found = await call(0, { query: needle });
      assert.equal(found.rows.length, 1);
      assert.ok(found.rows[0].observationRef.startsWith("o_"));
      assert.ok(!("version" in found.rows[0]));
      const exact = await call(1, {
        sessionId: found.rows[0].sessionId,
        observationRef: found.rows[0].observationRef,
      });
      assert.ok(exact.rows.length > 0);
      const expectedRef = (row: {
        sessionId: string;
        index: number;
        chunkCount: number;
        chunkIndex: number;
      }) =>
        `msg:${snapshot.snapshotId}:${row.sessionId}:${found.rows[0].observationRef}:${row.index}${row.chunkCount > 1 ? `#${row.chunkIndex}` : ""}`;
      for (const row of exact.rows) assert.equal(row.ref, expectedRef(row));
      assert.ok(exact.rows.some((row: { index: number }) => row.index === 1));
      assert.ok(exact.rows.some((row: { chunkCount: number }) => row.chunkCount > 1));
      const firstPage = await call(0, { query: "decoy" });
      assert.ok(firstPage.nextCursor);
      await assert.rejects(
        call(0, { query: needle, cursor: firstPage.nextCursor }),
        /Invalid cursor/,
      );
      assert.equal(
        (await searchCommittedTranscripts(snapshot, needle, true)).length,
        1,
        "source-hidden reasoning must not match even with current review permission",
      );
      assert.equal((await searchCommittedTranscripts(snapshot, reasoningMarker, false)).length, 0);
      assert.equal((await searchCommittedTranscripts(snapshot, reasoningMarker, true)).length, 1);
      const oldAlias = monitorSessionAlias(snapshot, old);
      const version2 = await readCommittedTranscript(snapshot, oldAlias, 2, false);
      for (const row of version2) assert.equal(row.ref, expectedRef(row));
      assert.deepEqual(
        exact.rows.map((row: { ref: string }) => row.ref),
        version2.map((row) => row.ref),
      );
      assert.equal(
        evidenceMessages(
          snapshot,
          old,
          [{ role: "user", content: "uncommitted", timestamp: 1 }],
          false,
        )[0].ref,
        `msg:${snapshot.snapshotId}:${oldAlias}:0`,
      );
      assert.ok(
        version2
          .filter((row) => row.index === 1)
          .map((row) => row.text)
          .join("")
          .includes(needle),
      );
      const version3 = await readCommittedTranscript(snapshot, oldAlias, 3, false);
      assert.ok(version3.every((row) => !row.text.includes(needle)));
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
      assert.equal(
        (await searchCommittedTranscripts(snapshot, needle, false)).length,
        1,
        "new committed evidence must stay outside the capture ceiling",
      );
      await pool.query("UPDATE ctf.games SET monitor_reasoning=false WHERE id=$1", [old]);
      await assert.rejects(
        searchCommittedTranscripts(snapshot, needle, true),
        /no longer available/,
      );
      await pool.query("UPDATE ctf.games SET monitor_reasoning=false WHERE id=$1", [target]);
      const restricted = await captureCommittedMonitorSnapshot({
        gameId: target,
        sessionId: target,
        epoch: 1,
        targetVersion: 2,
      });
      assert.equal(
        (await searchCommittedTranscripts(restricted, reasoningMarker, true)).length,
        0,
        "target review policy must hide source reasoning",
      );
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
      const parentId = randomUUID();
      const childId = randomUUID();
      const hidden = "legacy parent private thought";
      const fresh = "new child visible thought";
      const inherited = [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: hidden, thinkingSignature: "secret-signature" },
            { type: "text", text: "public inherited step" },
          ],
          timestamp: 1,
        },
      ] as unknown as Message[];
      const safeCopy = stripInheritedHiddenReasoning(inherited);
      await insert(parentId, owner, inherited);
      await pool.query("UPDATE ctf.games SET monitor_reasoning=false WHERE id=$1", [parentId]);
      await insert(childId, owner, safeCopy);
      const childClient = await pool.connect();
      try {
        await childClient.query("BEGIN");
        await persistTranscriptEvidence(childClient, {
          gameId: parentId,
          sessionId: parentId,
          runRevision: 0,
          messages: inherited,
        });
        await persistTranscriptEvidence(childClient, {
          gameId: childId,
          sessionId: childId,
          runRevision: 0,
          messages: safeCopy,
        });
        await persistTranscriptEvidence(childClient, {
          gameId: childId,
          sessionId: childId,
          runRevision: 1,
          messages: [
            ...safeCopy,
            {
              role: "assistant",
              content: [{ type: "thinking", thinking: fresh }],
              timestamp: 2,
            } as Message,
          ],
        });
        await childClient.query("COMMIT");
      } finally {
        childClient.release();
      }
      const childSnapshot = await captureCommittedMonitorSnapshot({
        gameId: childId,
        sessionId: childId,
        epoch: 1,
        targetVersion: 2,
      });
      const { makeInitialMonitorEvidence } = await import("../../lib/monitor-tools");
      const initial = makeInitialMonitorEvidence(childSnapshot, childId, {
        includeReasoning: true,
      });
      assert.ok(!JSON.stringify(initial).includes(hidden));
      assert.ok(JSON.stringify(initial).includes(fresh));
      assert.equal((await searchCommittedTranscripts(childSnapshot, hidden, true)).length, 0);
      assert.equal((await searchCommittedTranscripts(childSnapshot, fresh, true)).length, 1);
      const toolId = randomUUID();
      const argumentsWithPunctuation = {
        "10": "ten",
        "2": "two",
        "01": "leading zero",
        path: "/tmp/café_%/🧪",
        options: {
          label: 'comma, colon: quote " slash / and newline\n',
          numbers: [2, 10, 1e-7, 1e21, 1.25],
          nested: { percent: "%", underscore: "_", quote: '"' },
        },
      };
      const toolMessage = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "nested-call",
              name: "sprite_exec",
              arguments: argumentsWithPunctuation,
            },
          ],
          timestamp: 1,
        },
      ] as unknown as Message[];
      await insert(toolId, owner, toolMessage);
      const toolClient = await pool.connect();
      try {
        await toolClient.query("BEGIN");
        await persistTranscriptEvidence(toolClient, {
          gameId: toolId,
          sessionId: toolId,
          runRevision: 0,
          messages: toolMessage,
        });
        await toolClient.query("COMMIT");
      } finally {
        toolClient.release();
      }
      const toolSnapshot = await captureCommittedMonitorSnapshot({
        gameId: toolId,
        sessionId: toolId,
        epoch: 1,
        targetVersion: 1,
      });
      const visibleTool = makeInitialMonitorEvidence(toolSnapshot, toolId).currentTranscript[0]
        .text;
      const literalArguments = visibleTool.slice(visibleTool.indexOf("{"));
      assert.ok(literalArguments.includes("café_%/🧪"));
      assert.equal(
        (await searchCommittedTranscripts(toolSnapshot, literalArguments, false)).length,
        1,
        "literal query copied from visible tool-call arguments must match immutable search",
      );
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
