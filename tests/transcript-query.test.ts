import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
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

const SLOW_SQL =
  "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n) SELECT sum(x) FROM n";

const timed = async <T>(promise: Promise<T>) => {
  const result = await promise;
  return { result, at: performance.now() };
};

test("at most two SQL children run at once and aborted waiters release nothing", async () => {
  const cancelled = { ok: false, error: "SQL query cancelled." };
  const start = performance.now();
  const slow = [SLOW_SQL, SLOW_SQL].map((sql) =>
    runTranscriptSql(projection, sql, new AbortController().signal),
  );
  const controller = new AbortController();
  const queued = timed(runTranscriptSql(projection, "SELECT 1 AS one", controller.signal));
  await sleep(600 - (performance.now() - start));
  const abortedAt = performance.now();
  controller.abort();
  const queuedDone = await queued;
  assert.deepEqual(queuedDone.result, cancelled);
  assert.ok(queuedDone.at - abortedAt < 200, "queued abort settles promptly");
  const preAbortedAt = performance.now();
  const preAborted = await timed(
    runTranscriptSql(projection, "SELECT 1 AS one", AbortSignal.abort()),
  );
  assert.deepEqual(preAborted.result, cancelled);
  assert.ok(preAborted.at - preAbortedAt < 200, "pre-aborted call settles promptly");
  await Promise.all(slow);

  const phase2 = performance.now();
  const [slowA, slowB, quick] = await Promise.all([
    timed(runTranscriptSql(projection, SLOW_SQL, new AbortController().signal)),
    timed(runTranscriptSql(projection, SLOW_SQL, new AbortController().signal)),
    timed(runTranscriptSql(projection, "SELECT 1 AS one", new AbortController().signal)),
  ]);
  const timedOut = { ok: false, error: "SQL query timed out." };
  assert.deepEqual(slowA.result, timedOut);
  assert.deepEqual(slowB.result, timedOut);
  assert.ok(
    slowA.at - phase2 <= 1_800 && slowB.at - phase2 <= 1_800,
    "both slow queries admitted together",
  );
  assert.deepEqual(quick.result, {
    ok: true,
    rows: [{ one: 1 }],
    truncated: false,
  });
  assert.ok(quick.at - phase2 >= 900, "third query waited for a slot");
});

const withMessageText = (texts: string[]) => ({
  ...projection,
  messages: texts.map((text, index) => ({
    ...projection.messages[0],
    message_index: index,
    text,
  })),
});

test("a projection over the 12 MiB child input limit is rejected", async () => {
  await assert.rejects(
    runTranscriptSql(
      withMessageText(["x".repeat(13_000_000)]),
      "SELECT count(*) AS c FROM messages",
      new AbortController().signal,
    ),
    /SQLite query (input|process) failed/,
  );
});

test("a large projection under the limit is queried exactly", async () => {
  const result = await runTranscriptSql(
    withMessageText(Array.from({ length: 4 }, () => "y".repeat(2_500_000))),
    "SELECT count(*) AS c, sum(length(text)) AS l FROM messages",
    new AbortController().signal,
  );
  assert.deepEqual(result, {
    ok: true,
    rows: [{ c: 4, l: 10_000_000 }],
    truncated: false,
  });
});
