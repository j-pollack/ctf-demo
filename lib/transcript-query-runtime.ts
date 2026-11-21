import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export type SqlProjection = {
  sessions: Record<string, string | number | null>[];
  observations: Record<string, string | number | null>[];
  messages: Record<string, string | number | null>[];
};
export type SqlResult =
  | { ok: true; rows: Record<string, unknown>[]; truncated: boolean }
  | { ok: false; error: string };

const SQLITE_MODULE_URL = pathToFileURL(
  createRequire(import.meta.url).resolve("@sqlite.org/sqlite-wasm"),
).href;

const CHILD_SOURCE = String.raw`

const tables = {
  sessions: 'session_id TEXT,is_target INTEGER,latest_observation_ref TEXT',
  observations: 'observation_ref TEXT,session_id TEXT,observation_seq INTEGER,observed_at TEXT,changed_start INTEGER,message_count INTEGER',
  messages: 'observation_ref TEXT,session_id TEXT,message_index INTEGER,role TEXT,text TEXT,tool_call_id TEXT,tool_name TEXT,tool_error INTEGER,sent_at TEXT,returned_at TEXT',
};
const functions = new Set(['abs','avg','coalesce','count','glob','group_concat','hex','ifnull','instr','length','like','lower','ltrim','max','min','nullif','replace','round','rtrim','substr','substring','sum','total','trim','upper','zeroblob']);
let input = '';
let queryReady = false;
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) {
  input += chunk;
  if (Buffer.byteLength(input) > 12 * 1024 * 1024) throw new Error('Projection input exceeds child limit.');
}
try {
  const { projection, sql, runtimeUrl } = JSON.parse(input);
  if (typeof sql !== 'string' || Buffer.byteLength(sql) > 8192) throw new Error('SQL exceeds the 8 KiB limit.');
  const { default: initialize } = await import(runtimeUrl);
  const sqlite = await initialize({ print: () => {}, printErr: () => {} });
  const { capi, oo1, wasm } = sqlite;
  if (wasm.memory.buffer.byteLength > 67108864) throw new Error('SQLite memory starts above the 64 MiB cap.');
  let growthDenied = false;
  try { wasm.memory.grow(1024); } catch { growthDenied = true; }
  if (!growthDenied) throw new Error('SQLite WebAssembly memory cap is not enforced.');
  const db = new oo1.DB(':memory:', 'c');
  db.exec('PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY');
  for (const [name, columns] of Object.entries(tables)) db.exec('CREATE TABLE ' + name + '(' + columns + ')');
  for (const [name, rows] of Object.entries(projection)) {
    if (!Object.hasOwn(tables, name) || !Array.isArray(rows)) throw new Error('Invalid projection.');
    const columns = tables[name].split(',').map((part) => part.split(' ')[0]);
    const insert = db.prepare('INSERT INTO ' + name + '(' + columns.join(',') + ') VALUES (' + columns.map(() => '?').join(',') + ')');
    try {
      for (const row of rows) insert.bind(columns.map((column) => row[column] ?? null)).stepReset();
    } finally { insert.finalize(); }
  }
  db.exec('PRAGMA query_only=ON');
  const rc = capi.sqlite3_set_authorizer(db.pointer, (_userData, action, arg1, arg2, database) => {
    if (action === capi.SQLITE_SELECT || action === capi.SQLITE_RECURSIVE) return capi.SQLITE_OK;
    if (action === capi.SQLITE_READ && (database === 'main' || database === 0) && Object.hasOwn(tables, (arg1 ?? '').toLowerCase())) return capi.SQLITE_OK;
    if (action === capi.SQLITE_FUNCTION && functions.has((arg2 ?? '').toLowerCase())) return capi.SQLITE_OK;
    return capi.SQLITE_DENY;
  }, 0);
  if (rc !== capi.SQLITE_OK) throw new Error('SQLite authorizer setup failed.');
  queryReady = true;
  const statement = db.prepare(sql);
  if (capi.sqlite3_sql(statement.pointer).trim() !== sql.trim()) throw new Error('Submit exactly one SQL statement.');
  const rows = [];
  let bytes = 2;
  let truncated = false;
  while (statement.step()) {
    const raw = statement.get({});
    const row = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, typeof value === 'bigint' ? value.toString() : value]));
    const size = Buffer.byteLength(JSON.stringify(row), 'utf8') + 1;
    if (size > 12 * 1024) throw new Error('A result row exceeds 12 KiB; select narrower columns or substrings.');
    if (rows.length >= 1000 || bytes + size > 256 * 1024) { truncated = true; break; }
    rows.push(row);
    bytes += size;
  }
  statement.finalize();
  process.stdout.write(JSON.stringify({ ok: true, rows, truncated }));
  db.close();
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'SQL query failed.', fatal: !queryReady }));
}
`;

export async function runTranscriptSql(
  projection: SqlProjection,
  sql: string,
  signal: AbortSignal,
): Promise<SqlResult> {
  if (signal.aborted) return { ok: false, error: "SQL query cancelled." };
  if (Buffer.byteLength(sql, "utf8") > 8192)
    return { ok: false, error: "SQL exceeds the 8 KiB limit." };
  const child = spawn(
    process.execPath,
    [
      "--max-old-space-size=64",
      "--wasm-max-mem-pages=1024",
      "--input-type=module",
      "-e",
      CHILD_SOURCE,
    ],
    {
      env: { NODE_ENV: "production" },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let output = "";
  let timedOut = false;
  let aborted = false;
  let oversized = false;
  let stdinError: Error | undefined;
  const killForAbort = () => {
    aborted = true;
    child.kill("SIGKILL");
  };
  signal.addEventListener("abort", killForAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, 1_000);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
    if (Buffer.byteLength(output, "utf8") > 300_000) {
      oversized = true;
      child.kill("SIGKILL");
    }
  });
  child.stderr.resume();
  child.stdin.on("error", (error: Error) => {
    stdinError = error;
  });
  child.stdin.end(JSON.stringify({ projection, sql, runtimeUrl: SQLITE_MODULE_URL }));
  try {
    const [code] = await once(child, "close");
    if (aborted) return { ok: false, error: "SQL query cancelled." };
    if (timedOut) return { ok: false, error: "SQL query timed out." };
    if (oversized) return { ok: false, error: "SQL result exceeds the output limit." };
    if (stdinError) throw new Error("SQLite query input failed.", { cause: stdinError });
    if (code !== 0) throw new Error("SQLite query process failed.");
    const parsed = JSON.parse(output) as SqlResult & { fatal?: boolean };
    if (!parsed || typeof parsed.ok !== "boolean")
      throw new Error("Invalid SQLite query response.");
    if (parsed.fatal) throw new Error("SQLite query setup failed.");
    if (!parsed.ok) return { ok: false, error: parsed.error };
    return parsed;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", killForAbort);
  }
}
