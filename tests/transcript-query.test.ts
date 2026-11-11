import assert from "node:assert/strict";
import { test } from "node:test";
import { runTranscriptSql } from "../lib/transcript-query-runtime";

const projection = {
  sessions: [{ session_id: "s_target", is_target: 1, latest_observation_ref: "o_latest" }],
  observations: [
    {
      observation_ref: "o_latest",
      session_id: "s_target",
      observation_seq: 1,
      observed_at: "2026-01-01T00:00:00.000Z",
      changed_start: 0,
      message_count: 1,
    },
  ],
  messages: [
    {
      observation_ref: "o_latest",
      session_id: "s_target",
      message_index: 0,
      role: "tool",
      text: "read completed",
      tool_call_id: "call-1",
      tool_name: "sprite_exec",
      tool_error: 0,
    },
  ],
};

test("isolated SQLite allows joins and CTE search but denies schema and mutations", async () => {
  const signal = new AbortController().signal;
  const found = await runTranscriptSql(
    projection,
    "WITH hits AS (SELECT m.session_id, m.text FROM messages m WHERE m.text LIKE '%completed%') SELECT s.session_id,h.text FROM hits h JOIN sessions s ON s.session_id=h.session_id",
    signal,
  );
  assert.deepEqual(found, {
    ok: true,
    rows: [{ session_id: "s_target", text: "read completed" }],
    truncated: false,
  });
  for (const sql of [
    "SELECT name FROM sqlite_schema",
    "PRAGMA database_list",
    "DELETE FROM messages",
    "SELECT load_extension('/tmp/x')",
    "ATTACH DATABASE '/tmp/forbidden.db' AS forbidden",
    "SELECT * FROM pragma_table_info('messages')",
    "SELECT 1; SELECT 2",
    "SELEC missing syntax",
  ]) {
    const denied = await runTranscriptSql(projection, sql, signal);
    assert.equal(denied.ok, false, sql);
  }
});

test("a native SQLite query is killed on timeout and the next query succeeds", async () => {
  const slow = await runTranscriptSql(
    projection,
    "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n) SELECT sum(x) FROM n",
    new AbortController().signal,
  );
  assert.deepEqual(slow, { ok: false, error: "SQL query timed out." });
  const next = await runTranscriptSql(
    projection,
    "SELECT count(*) AS count FROM messages",
    new AbortController().signal,
  );
  assert.deepEqual(next, { ok: true, rows: [{ count: 1 }], truncated: false });
});

test("SQLite WebAssembly memory cap rejects a large engine allocation", async () => {
  const result = await runTranscriptSql(
    projection,
    "SELECT hex(zeroblob(100000000)) AS payload",
    new AbortController().signal,
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /out of memory|SQLITE_NOMEM/i);
});

test("abort kills an active SQL child and a fresh child still queries", async () => {
  const controller = new AbortController();
  const pending = runTranscriptSql(
    projection,
    "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n) SELECT sum(x) FROM n",
    controller.signal,
  );
  setTimeout(() => controller.abort(), 250);
  assert.deepEqual(await pending, { ok: false, error: "SQL query cancelled." });
  assert.deepEqual(
    await runTranscriptSql(projection, "SELECT 1 AS resumed", new AbortController().signal),
    { ok: true, rows: [{ resumed: 1 }], truncated: false },
  );
});

test("result rows and bytes stop at declared bounds", async () => {
  const rows = await runTranscriptSql(
    projection,
    "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1200) SELECT x FROM n",
    new AbortController().signal,
  );
  assert.equal(rows.ok, true);
  if (!rows.ok) return;
  assert.equal(rows.rows.length, 1000);
  assert.equal(rows.truncated, true);
  const wide = await runTranscriptSql(
    projection,
    "SELECT hex(zeroblob(7000)) AS large_row",
    new AbortController().signal,
  );
  assert.equal(wide.ok, false);
  if (!wide.ok) assert.match(wide.error, /select narrower columns/i);
});
