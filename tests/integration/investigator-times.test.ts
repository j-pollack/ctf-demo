import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import { Pool } from "pg";
import { closePool } from "./postgres";
import { FLAG_READ_MONITOR_VERSION, PREVIOUS_FLAG_READ_MONITOR_VERSION } from "../../lib/control";
import { repairMessages } from "../../lib/transcript-repair";
import { migrateFreshDatabase, seedWorkspace } from "../../scripts/monitor-investigate-eval-live";
import type { FixtureOperation } from "../../scripts/monitor-investigation-cases";

const parentURL = new URL(process.env.CTF_INTEGRATION_DATABASE_URL ?? "http://missing");
assert.equal(parentURL.hostname, "127.0.0.1");
assert.match(parentURL.pathname, /^\/ctf_integration_[a-f0-9]{32}$/);
const databaseName = `ctf_times_${randomUUID().replaceAll("-", "")}`;
const adminURL = new URL(parentURL);
adminURL.pathname = "/postgres";
const testURL = new URL(parentURL);
testURL.pathname = `/${databaseName}`;

const MODEL = "synthetic-times";
const call = (id: string, timestamp: number): Message => ({
  role: "assistant",
  content: [{ type: "toolCall", id, name: "sprite_exec", arguments: { command: `run ${id}` } }],
  api: "openai-completions",
  provider: "openrouter",
  model: MODEL,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "toolUse",
  timestamp,
});
const result = (id: string, text: string, timestamp: number): Message => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "sprite_exec",
  content: [{ type: "text", text }],
  isError: false,
  timestamp,
});
const operation = (toolCallId: string, second: number, returned = true): FixtureOperation => ({
  toolCallId,
  sentAt: `2026-11-20T10:00:0${second}.250Z`,
  returnedAt: returned ? `2026-11-20T10:00:0${second}.750Z` : null,
});
const session = (
  id: string,
  ordinal: number,
  messages: Message[],
  operations?: FixtureOperation[],
) => ({
  id,
  ordinal,
  agentModel: MODEL,
  agentEffort: "medium" as const,
  turns: messages.filter((message) => message.role === "assistant").length,
  busy: false,
  messages,
  ...(operations ? { operations } : {}),
});

test(
  "the investigator's rows and SQL carry each command's send and return times",
  { timeout: 120_000 },
  async () => {
    const admin = new Pool({ connectionString: adminURL.toString() });
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const pool = new Pool({
      connectionString: testURL.toString(),
      options: "-c search_path=ctf,public",
    });
    (globalThis as typeof globalThis & { ctfPool?: Pool }).ctfPool = pool;
    try {
      await migrateFreshDatabase(pool);
      const { captureCommittedMonitorSnapshot } = await import("../../lib/monitor-snapshot");
      const { createTranscriptInvestigationTools } = await import("../../lib/transcript-query");
      const { monitorSessionAlias } = await import("../../lib/monitor-tools");
      const owner = `times-owner-${randomUUID()}`;
      const seed = (sessions: ReturnType<typeof session>[], version: string, isolated: boolean) =>
        seedWorkspace(
          pool,
          { gameId: "times", revision: 1, sessions, commands: [] },
          owner,
          1_000_000,
          MODEL,
          "typesafe/jev-1.14",
          version,
          { isolated },
        );
      // c1 completed, c2 interrupted (no return time), c3 has no operation row, c4 was dispatched
      // and has only the placeholder transcript repair wrote.
      const targetMessages = repairMessages([
        { role: "user", content: "start", timestamp: 1 },
        call("c1", 1_000),
        result("c1", "first output", 2_000),
        call("c2", 3_000),
        result("c2", "second output", 4_000),
        call("c3", 5_000),
        result("c3", "third output", 6_000),
        call("c4", 7_000),
      ]);
      const targetOperations = [
        operation("c1", 1),
        operation("c2", 2, false),
        operation("c4", 4, false),
      ];
      const isolatedRun = await seed(
        [
          session("target", 1, targetMessages, targetOperations),
          session(
            "sibling",
            2,
            [call("s1", 1_000), result("s1", "sibling output", 2_000)],
            [operation("s1", 5)],
          ),
        ],
        FLAG_READ_MONITOR_VERSION,
        true,
      );
      const openRun = await seed(
        [
          session(
            "open-target",
            1,
            [call("o1", 1_000), result("o1", "open output", 2_000)],
            [operation("o1", 6)],
          ),
        ],
        FLAG_READ_MONITOR_VERSION,
        false,
      );
      // A run of the same owner stamped with the other version, and a session with no operations.
      const otherVersionRun = await seed(
        [
          session(
            "old",
            1,
            [call("b1", 1_000), result("b1", "old output", 2_000)],
            [operation("b1", 7)],
          ),
          session("bare", 2, [call("n1", 1_000), result("n1", "bare output", 2_000)], []),
        ],
        PREVIOUS_FLAG_READ_MONITOR_VERSION,
        false,
      );
      const capture = async (workspace: typeof isolatedRun, name: string) => {
        const sessionId = workspace.sessionIds.get(name)!;
        const {
          rows: [head],
        } = await pool.query(
          "SELECT version::text,epoch::text FROM ctf.transcript_observations WHERE session_id=$1 ORDER BY version DESC LIMIT 1",
          [sessionId],
        );
        const snapshot = await captureCommittedMonitorSnapshot({
          gameId: workspace.gameId,
          sessionId,
          epoch: Number(head.epoch),
          targetVersion: Number(head.version),
        });
        const tools = await createTranscriptInvestigationTools(snapshot, sessionId, {
          includeReasoning: false,
          signal: new AbortController().signal,
          onPage: () => {},
          onFatal: (error) => assert.fail(String(error)),
        });
        const run = async (tool: string, args: object) => {
          const response = await tools.piTools
            .find((item) => item.name === tool)!
            .execute(randomUUID(), args as never, undefined, undefined);
          return JSON.parse((response.content[0] as { text: string }).text);
        };
        return { snapshot, tools, sessionId, run };
      };
      type Row = {
        toolCallId?: string;
        role: string;
        sentAt?: string | null;
        returnedAt?: string | null;
      };
      const timesOf = (rows: Row[]) =>
        Object.fromEntries(
          rows
            .filter((row) => row.role === "tool")
            .map((row) => [row.toolCallId, [row.sentAt, row.returnedAt]]),
        );
      const stored = async (toolCallId: string) => {
        const {
          rows: [row],
        } = await pool.query(
          "SELECT started_at,returned_at FROM ctf.sprite_operations WHERE tool_call_id=$1",
          [toolCallId],
        );
        return [row.started_at.toISOString(), row.returned_at?.toISOString() ?? null];
      };

      const iso = await capture(isolatedRun, "target");
      try {
        // T1: the excerpt, a read page and SQL agree with the operation rows.
        const excerpt = timesOf(iso.tools.initialEvidence.currentTranscript);
        const page = await iso.run("read_transcript", {
          sessionId: monitorSessionAlias(iso.snapshot, iso.sessionId),
        });
        assert.equal(page.ok, true);
        assert.deepEqual(timesOf(page.rows), excerpt);
        assert.deepEqual(excerpt.c1, await stored("c1"));
        assert.equal(excerpt.c1?.[1], "2026-11-20T10:00:01.750Z");
        const sql = await iso.run("query_transcripts", {
          sql: "SELECT tool_call_id,sent_at,returned_at FROM messages WHERE role='tool' AND session_id=(SELECT session_id FROM sessions WHERE is_target=1) ORDER BY tool_call_id",
        });
        assert.equal(sql.ok, true);
        assert.deepEqual(
          Object.fromEntries(
            sql.rows.map((row: { tool_call_id: string; sent_at: string; returned_at: string }) => [
              row.tool_call_id,
              [row.sent_at, row.returned_at],
            ]),
          ),
          excerpt,
        );
        // T3: an unfinished command keeps its send time, a command without an operation has none,
        // and the repair placeholder carries its own command's times.
        assert.deepEqual(excerpt.c2, [(await stored("c2"))[0], null]);
        assert.deepEqual(excerpt.c3, [null, null]);
        assert.deepEqual(excerpt.c4, [(await stored("c4"))[0], null]);
        assert.equal(
          page.rows.find((row: Row) => row.toolCallId === "c4").text,
          "The previous response was interrupted. Execution status is unknown.",
        );
        // T2: with isolation on, another session of the run has its times and another run is absent.
        const evidence = await iso.run("query_transcripts", {
          sql: "SELECT tool_call_id,sent_at FROM messages WHERE role='tool' AND tool_call_id IN ('s1','o1','b1','n1') ORDER BY tool_call_id",
        });
        assert.deepEqual(evidence.rows, [
          { tool_call_id: "s1", sent_at: "2026-11-20T10:00:05.250Z" },
        ]);
        // T4: the schema names both columns, and a player-controlled message time changes nothing.
        assert.match(iso.tools.initialEvidence.schema, /sent_at,returned_at\)/);
        assert.match(
          iso.tools.initialEvidence.schema,
          /sent_at and returned_at are server times for the request that ran the command\. They bound when its effects happened\./,
        );
      } finally {
        await iso.tools.dispose();
      }
      await pool.query(
        `UPDATE ctf.transcript_observations SET changed_messages=(
           SELECT coalesce(jsonb_agg(jsonb_set(m,'{timestamp}','1'::jsonb)),'[]'::jsonb)
           FROM jsonb_array_elements(changed_messages) m)
         WHERE session_id=$1`,
        [isolatedRun.sessionIds.get("target")],
      );
      const altered = await capture(isolatedRun, "target");
      try {
        assert.deepEqual(
          timesOf(altered.tools.initialEvidence.currentTranscript),
          timesOf(iso.tools.initialEvidence.currentTranscript),
        );
      } finally {
        await altered.tools.dispose();
      }

      // T2 and T6: with isolation off the owner's other runs are in the evidence, whatever their
      // stamp, and their sessions carry times. A session without operation rows loads with nulls.
      const open = await capture(openRun, "open-target");
      try {
        const all = await open.run("query_transcripts", {
          sql: "SELECT tool_call_id,sent_at,returned_at FROM messages WHERE role='tool' AND tool_call_id IN ('s1','o1','b1','n1') ORDER BY tool_call_id",
        });
        assert.deepEqual(all.rows, [
          {
            tool_call_id: "b1",
            sent_at: "2026-11-20T10:00:07.250Z",
            returned_at: "2026-11-20T10:00:07.750Z",
          },
          { tool_call_id: "n1", sent_at: null, returned_at: null },
          {
            tool_call_id: "o1",
            sent_at: "2026-11-20T10:00:06.250Z",
            returned_at: "2026-11-20T10:00:06.750Z",
          },
          {
            tool_call_id: "s1",
            sent_at: "2026-11-20T10:00:05.250Z",
            returned_at: "2026-11-20T10:00:05.750Z",
          },
        ]);
        assert.equal(open.snapshot.isolated, false);
        assert.equal(open.snapshot.evidenceManifest?.length, 5);
        const old = await pool.query("SELECT monitor_version FROM ctf.games WHERE id=$1", [
          otherVersionRun.gameId,
        ]);
        assert.equal(old.rows[0].monitor_version, PREVIOUS_FLAG_READ_MONITOR_VERSION);
      } finally {
        await open.tools.dispose();
      }

      // T3: a database without the operations table loads, with no times.
      await pool.query("ALTER TABLE ctf.sprite_operations RENAME TO sprite_operations_hidden");
      try {
        const bare = await capture(openRun, "open-target");
        try {
          assert.deepEqual(bare.snapshot.operationTimes, []);
          assert.deepEqual(timesOf(bare.tools.initialEvidence.currentTranscript), {
            o1: [null, null],
          });
        } finally {
          await bare.tools.dispose();
        }
      } finally {
        await pool.query("ALTER TABLE ctf.sprite_operations_hidden RENAME TO sprite_operations");
      }

      // T5: with times on every row the excerpt keeps its 8 KiB limit and a page its 12 KiB limit.
      const many = await seed(
        [
          session(
            "many",
            1,
            Array.from({ length: 80 }, (_, index) => [
              call(`m${index}`, 1_000 + index),
              result(`m${index}`, "z".repeat(300), 2_000 + index),
            ]).flat(),
            Array.from({ length: 80 }, (_, index) => operation(`m${index}`, 1)),
          ),
        ],
        FLAG_READ_MONITOR_VERSION,
        true,
      );
      const big = await capture(many, "many");
      try {
        const size = (rows: unknown[]) =>
          rows.reduce<number>((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)) + 1, 2);
        const excerptRows = big.tools.initialEvidence.currentTranscript;
        assert.ok(excerptRows.length > 5 && size(excerptRows) <= 8 * 1024);
        assert.ok(excerptRows.some((row) => row.role === "tool" && row.sentAt && row.returnedAt));
        const page = await big.run("read_transcript", {
          sessionId: monitorSessionAlias(big.snapshot, big.sessionId),
        });
        assert.ok(page.rows.length > 5 && size(page.rows) <= 12 * 1024);
        assert.ok(page.remaining > 0 && page.nextCursor);
      } finally {
        await big.tools.dispose();
      }
    } finally {
      await closePool(pool);
      delete (globalThis as typeof globalThis & { ctfPool?: Pool }).ctfPool;
      await admin.query(`DROP DATABASE ${databaseName}`);
      await admin.end();
    }
  },
);
