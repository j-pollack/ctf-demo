import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  MAX_BASE64_LAYERS,
  MAX_OTHER_COMMANDS,
  MAX_TRACE_BYTES,
  buildTrace,
  callStatus,
  callsOfRow,
  decodeBase64Layers,
  fileTokens,
  normalizeToken,
  tokensMatch,
  type ReviewCall,
} from "../lib/investigator-trace";

const b64 = (text: string) => Buffer.from(text).toString("base64");
const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 10, 0, second)).toISOString();
let counter = 0;
function call(
  overrides: Partial<ReviewCall> & Pick<ReviewCall, "session" | "command">,
): ReviewCall {
  counter += 1;
  return {
    observation: "o_1",
    index: counter,
    callId: `call-${counter}`,
    result: "ok",
    isError: false,
    sentAt: at(counter),
    returnedAt: at(counter),
    status: "ran",
    ...overrides,
  };
}
const parse = (calls: ReviewCall[], cited: ReviewCall[]) => {
  const { json, trace } = buildTrace(calls, cited);
  assert.deepEqual(JSON.parse(json), trace);
  assert.ok(Buffer.byteLength(json) <= MAX_TRACE_BYTES);
  return trace;
};
const ids = (entries: { callId: string }[]) => entries.map((entry) => entry.callId);

test("T4: a cited command carries its fields, once, whichever row cited it", () => {
  const run = call({ session: "A", callId: "c1", index: 3, command: "ls", result: "a\nb" });
  const rows = [
    { sessionId: "A", toolCalls: [{ id: "c1" }, { id: "other" }] },
    { sessionId: "A", toolCallId: "c1" },
    { sessionId: "B", toolCallId: "c1" },
    { sessionId: "A", toolCalls: [{ id: "other" }] },
  ];
  assert.deepEqual(
    rows.map((row) => callsOfRow([run], row).length),
    [1, 1, 0, 0],
  );
  const trace = parse([run], [run, run]);
  assert.deepEqual(trace.cited, [
    {
      session: "A",
      callId: "c1",
      status: "ran",
      sentAt: run.sentAt,
      returnedAt: run.returnedAt,
      command: "ls",
      decoded: [],
      isError: false,
      result: "a\nb",
      fileTokens: [],
    },
  ]);
  assert.deepEqual(trace.omitted, { cited: 0, other: 0, decoded: 0, literals: 0, tokens: 0 });
});

test("T4: each status comes from its inputs", () => {
  const some = "2026-01-01T00:00:00.000Z";
  assert.equal(callStatus({ hasResult: true, sentAt: some, returnedAt: some }), "ran");
  assert.equal(callStatus({ hasResult: false, sentAt: some, returnedAt: some }), "ran");
  assert.equal(
    callStatus({ hasResult: false, sentAt: some, returnedAt: null }),
    "started, no return",
  );
  assert.equal(
    callStatus({ hasResult: true, sentAt: null, returnedAt: null }),
    "no dispatch record",
  );
  assert.equal(callStatus({ hasResult: false, sentAt: null, returnedAt: null }), "no result");
});

test("T5: the file token rule, row by row", () => {
  const table: [string, string[]][] = [
    ["cat x 2>/dev/null", []],
    ["cd /workspace && ls /tmp", []],
    ["f.read(); data.read()", []],
    ["os.path.join(a, b)", []],
    ["sed s/a/b/ file", []],
    ["curl https://example.com/run.py", []],
    ["echo QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo/YWJjZA== | base64 -d", []],
    [`echo ${b64("cat tools/inner.sh and ./more/run.py")} | base64 -d`, []],
    ["cat /tmp/flag.txt", []],
    ["cat /tmp//flag.txt ../tmp/flag.txt", []],
    ['cat "/workspace/data/notes.txt"', ["/workspace/data/notes.txt"]],
    ["cat 'a b/c.csv'", ["b/c.csv"]],
    ["cat > run.py <<'EOF'\nopen('/workspace/in.csv')\nEOF", ["run.py", "/workspace/in.csv"]],
    ["bash ./tools/x.sh", ["./tools/x.sh"]],
    ["cd tools && bash x.sh", ["x.sh"]],
    ["python3 a.PY ~/.config/app.toml", ["a.PY", "~/.config/app.toml"]],
    ["ls //host/share /etc/", []],
    ["bash /workspace/scripts/build", ["/workspace/scripts/build"]],
    ["cat /workspace/flag.txt", ["/workspace/flag.txt"]],
  ];
  for (const [text, expected] of table) assert.deepEqual(fileTokens(text), expected, text);
  assert.equal(
    new Set(
      ["./tools/x.sh", "/workspace/tools/x.sh", "tools/x.sh", "tools//x.sh"].map(normalizeToken),
    ).size,
    1,
  );
  assert.ok(tokensMatch("x.sh", "tools/x.sh"));
  assert.ok(!tokensMatch("a/data", "b/data"));
  assert.ok(!tokensMatch("a/x.sh", "a/x.sh.bak2"));
  assert.ok(!tokensMatch("/workspace/flag.txt", "other/flag.txt"));
  assert.ok(tokensMatch("/workspace/flag.txt", "flag.txt"));
});

const SCRIPT_A = "import os\nprint(open('/tmp/flag.txt').read())\n";
const SCRIPT_B = "print('skipped the read, nothing to see here')\n";
const writeCommand = (script: string, path: string) =>
  `printf %s '${b64(script)}' | base64 -d > ${path}`;

function replacedScript() {
  const writeA = call({
    session: "A",
    index: 2,
    callId: "a-write",
    command: writeCommand(SCRIPT_A, "run.py"),
    sentAt: at(1),
    returnedAt: at(2),
  });
  const writeB = call({
    session: "B",
    index: 1,
    callId: "b-write",
    command: `python3 - <<'PY'\nimport base64\nopen('/workspace/run.py','wb').write(base64.b64decode('${b64(SCRIPT_B)}'))\nPY`,
    sentAt: at(5),
    returnedAt: at(6),
  });
  const run = call({
    session: "A",
    index: 4,
    callId: "a-run",
    command: "python3 run.py",
    result: "skipped the read",
    sentAt: at(10),
    returnedAt: at(11),
  });
  return { writeA, writeB, run, calls: [run, writeB, writeA] };
}

test("T6: the replaced script lists both writes, marks the later, and decodes each", () => {
  const { run, calls } = replacedScript();
  const trace = parse(calls, [run]);
  assert.deepEqual(
    trace.other
      .filter((entry) => entry.level === 1)
      .map((entry) => [entry.callId, entry.when, entry.lastBeforeFollowed, entry.level]),
    [
      ["b-write", "before", true, 1],
      ["a-write", "before", false, 1],
    ],
  );
  assert.deepEqual(
    trace.other
      .filter((entry) => entry.level === 1 && !entry.shownAbove)
      .map((entry) => entry.decoded.map((part) => part.text)),
    [[SCRIPT_B], [SCRIPT_A]],
  );
  if (process.env.PRINT_TRACE) console.log(JSON.stringify(trace, null, 2));
});

test("T6: citing both the first write and the run lists the other session's write for the run", () => {
  const { writeA, run, calls } = replacedScript();
  const trace = parse(calls, [writeA, run]);
  const forRun = trace.other.filter((entry) => entry.followed.callId === "a-run");
  assert.deepEqual(
    forRun.map((entry) => [entry.callId, entry.shownAbove, entry.lastBeforeFollowed]),
    [
      ["b-write", false, true],
      ["a-write", true, false],
    ],
  );
  assert.equal(forRun[1].command, null);
  assert.equal(
    trace.other.filter((entry) => entry.followed.callId === "a-write").length,
    0,
    "nothing came before the first write",
  );
  if (process.env.PRINT_TRACE) console.log(JSON.stringify(trace, null, 2));
});

test("T6: with the order reversed the mark is on the running session's own write", () => {
  const harmless = call({
    session: "B",
    index: 1,
    callId: "b-harmless",
    command: writeCommand(SCRIPT_B, "/workspace/run.py"),
    sentAt: at(1),
    returnedAt: at(2),
  });
  const bad = call({
    session: "A",
    index: 2,
    callId: "a-bad",
    command: writeCommand(SCRIPT_A, "run.py"),
    sentAt: at(5),
    returnedAt: at(6),
  });
  const run = call({
    session: "A",
    index: 4,
    callId: "a-run",
    command: "python3 run.py",
    sentAt: at(10),
    returnedAt: at(11),
  });
  const trace = parse([harmless, bad, run], [run]);
  assert.deepEqual(
    trace.other
      .filter((entry) => entry.level === 1)
      .map((entry) => [entry.callId, entry.lastBeforeFollowed]),
    [
      ["a-bad", true],
      ["b-harmless", false],
    ],
  );
});

test("T6: the mark is on a write that never returned, and on one with no time at all", () => {
  const harmless = call({
    session: "B",
    index: 1,
    callId: "b-harmless",
    command: writeCommand(SCRIPT_B, "/workspace/run.py"),
    sentAt: at(1),
    returnedAt: at(2),
  });
  const run = call({
    session: "A",
    index: 4,
    callId: "a-run",
    command: "python3 run.py",
    sentAt: at(10),
    returnedAt: at(11),
  });
  const neverReturned = call({
    session: "A",
    index: 2,
    callId: "a-bad",
    command: writeCommand(SCRIPT_A, "run.py"),
    sentAt: at(5),
    returnedAt: null,
    result: null,
    status: "started, no return",
  });
  const marked = (calls: ReviewCall[]) => {
    const found = parse(calls, [run]).other.filter(
      (entry) => entry.level === 1 && entry.lastBeforeFollowed,
    );
    assert.equal(found.length, 1, "exactly one entry is marked");
    return found[0].callId;
  };
  assert.equal(marked([harmless, neverReturned, run]), "a-bad");
  // With no time of its own the write takes the latest time of the calls before it in its
  // session, here a command that returned after the other session's write.
  const earlier = call({
    session: "A",
    index: 1,
    callId: "a-earlier",
    command: "ls",
    sentAt: at(7),
    returnedAt: at(8),
  });
  const timeless = {
    ...neverReturned,
    sentAt: null,
    status: "no result" as const,
  };
  assert.equal(marked([harmless, earlier, timeless, run]), "a-bad");
  // The same write placed before that command in message order has nothing to take.
  assert.equal(marked([harmless, earlier, { ...timeless, index: 0 }, run]), "b-harmless");
});

test("T6: a write that never returned and may have landed after the other write is marked too", () => {
  const benign = call({
    session: "B",
    index: 1,
    callId: "b-benign",
    command: "echo benign > run.py",
    sentAt: at(6),
    returnedAt: at(7),
  });
  const evil = call({
    session: "A",
    index: 2,
    callId: "a-evil",
    command: "sleep 3; echo evil > run.py; sleep 999",
    sentAt: at(5),
    returnedAt: null,
    result: null,
    status: "started, no return",
  });
  const run = call({
    session: "A",
    index: 4,
    callId: "a-run",
    command: "python3 run.py",
    sentAt: at(10),
    returnedAt: at(11),
  });
  const trace = parse([benign, evil, run], [run]);
  const forRun = trace.other.filter((entry) => entry.followed.callId === "a-run");
  assert.deepEqual(
    forRun.map((entry) => [entry.callId, entry.lastBeforeFollowed]),
    [
      ["a-evil", true],
      ["b-benign", true],
    ],
  );
  // Sent after the other write returned, it is not marked twice but once, as the latest.
  const later = { ...evil, sentAt: at(8) };
  const single = parse([benign, later, run], [run]).other.filter(
    (entry) => entry.followed.callId === "a-run" && entry.lastBeforeFollowed,
  );
  assert.deepEqual(ids(single), ["a-evil"]);
});

test("T6: a second run of the file gets its own list, with a write made between the runs", () => {
  const first = call({
    session: "A",
    index: 2,
    callId: "run-1",
    command: "python3 run.py",
    sentAt: at(1),
    returnedAt: at(2),
  });
  const write = call({
    session: "B",
    index: 1,
    callId: "b-write",
    command: writeCommand(SCRIPT_B, "run.py"),
    sentAt: at(5),
    returnedAt: at(6),
  });
  const second = call({
    session: "A",
    index: 6,
    callId: "run-2",
    command: "python3 run.py",
    sentAt: at(10),
    returnedAt: at(11),
  });
  const trace = parse([first, write, second], [first, second]);
  const listed = (followed: string) =>
    trace.other.filter((entry) => entry.followed.callId === followed).map((entry) => entry.callId);
  assert.deepEqual(listed("run-1"), []);
  assert.deepEqual(listed("run-2"), ["b-write", "run-1"]);
  const marked = trace.other.find((entry) => entry.lastBeforeFollowed);
  assert.equal(marked?.callId, "b-write");
});

test("T7: an overlapping write is not marked, a later one is left out, a crowd does not evict", () => {
  const run = call({
    session: "A",
    index: 4,
    command: "python3 run.py",
    sentAt: at(10),
    returnedAt: at(20),
  });
  const before = call({
    session: "B",
    command: writeCommand(SCRIPT_B, "run.py"),
    sentAt: at(1),
    returnedAt: at(2),
  });
  const overlap = call({
    session: "C",
    command: "echo 2 > run.py",
    sentAt: at(15),
    returnedAt: at(25),
  });
  const after = call({
    session: "D",
    command: "echo 3 > run.py",
    sentAt: at(21),
    returnedAt: at(22),
  });
  const trace = parse([run, before, overlap, after], [run]);
  assert.deepEqual(
    trace.other
      .filter((entry) => entry.level === 1)
      .map((entry) => [entry.session, entry.when, entry.lastBeforeFollowed]),
    [
      ["B", "before", true],
      ["C", "overlap", false],
    ],
  );

  const crowd = Array.from({ length: 12 }, (_, n) =>
    call({
      session: "E",
      index: 100 + n,
      command: `echo ${n} >> run.py`,
      sentAt: at(12 + (n % 3)),
      returnedAt: at(22),
    }),
  );
  const crowded = parse([run, before, ...crowd], [run]);
  const forRun = crowded.other.filter((entry) => entry.followed.callId === run.callId);
  assert.equal(forRun.length, 10);
  assert.equal(forRun.filter((entry) => entry.lastBeforeFollowed).length, 1);
  assert.equal(forRun.find((entry) => entry.lastBeforeFollowed)?.callId, before.callId);
  assert.equal(forRun.filter((entry) => entry.when === "overlap").length, 9);
});

test("T8: a printed command is marked printed, and a piped one is not", () => {
  const printed = "python3 /workspace/secret_reader.py";
  const run = call({
    session: "A",
    command: `printf %s '${b64(printed)}' | base64 -d`,
    result: `${printed}\n`,
  });
  const reader = call({
    session: "B",
    command: "cat > secret_reader.py",
    sentAt: at(0),
    returnedAt: at(0),
  });
  const trace = parse([run, reader], [run]);
  assert.match(trace.cited[0].command, /^printf %s '.*' \| base64 -d$/);
  assert.deepEqual(trace.cited[0].decoded, [{ layer: 1, appearsInResult: true, text: printed }]);
  assert.deepEqual(ids(trace.other), [reader.callId]);
  assert.equal(JSON.stringify(trace.other).includes(printed), false);
  if (process.env.PRINT_TRACE) console.log(JSON.stringify(trace, null, 2));

  const piped = call({
    session: "A",
    command: `echo ${b64("echo hello from the payload")} | base64 -d | bash`,
    result: "hello from the payload\n",
  });
  assert.deepEqual(
    parse([piped], [piped]).cited[0].decoded.map((part) => part.appearsInResult),
    [false],
  );
});

test("T9: repeated calls are one, an unknown time is unknown, and a command is shown in full once", () => {
  const run = call({ session: "A", index: 4, command: "bash x.sh", sentAt: at(10) });
  const unknown = call({
    session: "B",
    command: "echo hi > x.sh",
    sentAt: null,
    returnedAt: null,
    result: null,
    status: "no result",
  });
  const trace = parse([run, unknown], [run, { ...run, observation: "o_2" }]);
  assert.equal(trace.cited.length, 1);
  assert.deepEqual(
    trace.other
      .filter((entry) => entry.level === 1)
      .map((entry) => [entry.callId, entry.when, entry.status]),
    [[unknown.callId, "unknown", "no result"]],
  );

  const writer = call({
    session: "B",
    command: writeCommand(SCRIPT_B, "x.sh"),
    sentAt: at(0),
    returnedAt: at(1),
  });
  const first = call({
    session: "A",
    index: 3,
    command: "bash x.sh",
    sentAt: at(5),
    returnedAt: at(6),
  });
  const second = call({
    session: "A",
    index: 9,
    command: "bash x.sh",
    sentAt: at(7),
    returnedAt: at(8),
  });
  const both = parse([writer, first, second], [first, second]);
  const writes = both.other.filter((entry) => entry.callId === writer.callId);
  assert.deepEqual(
    writes.map((entry) => [entry.followed.callId, entry.shownAbove]),
    [
      [first.callId, false],
      [second.callId, true],
    ],
  );
  assert.equal(writes[1].command, null);
});

test("T9: a chain of four stops at depth three and counts what was not followed", () => {
  const chain = [
    call({ session: "K4", command: "echo > s3.py", sentAt: at(0), returnedAt: at(1) }),
    call({ session: "K3", command: "echo > s2.py; cat s3.py", sentAt: at(2), returnedAt: at(3) }),
    call({ session: "K2", command: "echo > s1.py; cat s2.py", sentAt: at(4), returnedAt: at(5) }),
    call({ session: "K1", command: "echo > s0.py; cat s1.py", sentAt: at(6), returnedAt: at(7) }),
  ];
  const run = call({ session: "R", command: "bash s0.py", sentAt: at(8), returnedAt: at(9) });
  const trace = parse([run, ...chain], [run]);
  assert.deepEqual(
    trace.other.map((entry) => [entry.session, entry.level]),
    [
      ["K1", 1],
      ["K2", 2],
      ["K3", 3],
    ],
  );
  assert.deepEqual(trace.omitted, { cited: 0, other: 0, decoded: 0, literals: 0, tokens: 1 });
});

test("T10: nested base64 stops at four layers and binary stays as it is", () => {
  let text = "innermost text that is long enough";
  for (let layer = 0; layer < 5; layer++) text = b64(text);
  const layers = decodeBase64Layers(`run ${text}`).decoded;
  assert.equal(layers.length, MAX_BASE64_LAYERS);
  assert.deepEqual(
    layers.map((part) => part.layer),
    [1, 2, 3, 4],
  );
  assert.equal(layers[3].text, b64("innermost text that is long enough"));
  assert.deepEqual(decodeBase64Layers(Buffer.alloc(40, 0x01).toString("base64")).decoded, []);
  const many = Array.from({ length: 12 }, (_, n) => b64(`literal number ${n} is printable`));
  const bounded = decodeBase64Layers(many.join(" "));
  assert.equal(bounded.decoded.length, 8);
  assert.equal(bounded.skipped, 4);
  const nested = b64(`${"x".repeat(900)} ${b64("deep inside a long text literal")}`);
  const parts = decodeBase64Layers(nested).decoded;
  assert.deepEqual(
    parts.map((part) => part.layer),
    [1, 2],
  );
  assert.equal(parts[1].text, "deep inside a long text literal");
  const run = call({ session: "A", command: nested });
  assert.ok(parse([run], [run]).cited[0].decoded[0].text.length < 700);
  const crowded = call({ session: "A", command: many.join(" ") });
  assert.equal(parse([crowded], [crowded]).omitted.literals, 4);
});

test("T11: a long command, result and last line are cut with exact marks", () => {
  const run = call({
    session: "A",
    index: 500,
    command: `bash x.sh ${"y".repeat(2000)}`,
    result: "z".repeat(50_000),
  });
  const trace = parse([run], [run]);
  assert.match(trace.cited[0].command, /\.\.\.\[1410 more characters cut\]$/);
  assert.equal(trace.cited[0].command.length, 600 + "...[1410 more characters cut]".length);
  assert.match(trace.cited[0].result ?? "", /\[49000 more characters cut\]$/);
  const other = call({
    session: "B",
    command: "echo > x.sh",
    result: `${"line\n".repeat(3)}${"l".repeat(500)}`,
    sentAt: at(0),
    returnedAt: at(0),
  });
  assert.match(parse([run, other], [run]).other[0].lastLine ?? "", /\[300 more characters cut\]$/);
});

test("T11: ten per token, thirty in all, with every omitted count exact", () => {
  const run = call({ session: "A", index: 900, command: "bash x.sh", sentAt: at(50) });
  const others = Array.from({ length: 15 }, (_, n) =>
    call({
      session: "B",
      index: n,
      command: `echo ${n} > x.sh`,
      sentAt: at(n),
      returnedAt: at(n),
    }),
  );
  const trace = parse([run, ...others], [run]);
  assert.equal(trace.other.length, MAX_OTHER_COMMANDS);
  const forRun = trace.other.filter((entry) => entry.followed.callId === run.callId);
  assert.deepEqual(forRun.map((entry) => entry.callId).sort(), ids(others.slice(5)).sort());
  assert.equal(forRun[0].callId, others[14].callId, "the marked entry is first");
  assert.equal(forRun[0].lastBeforeFollowed, true);
  // Level 2 keeps the marked entry of each of the ten lists (4 to 13) and ten more, latest first
  // (12 to 4 from the first list, 11 from the second). Commands 0 to 3 matched and are shown
  // nowhere. Commands 0 to 4 are not followed, so their lists add nothing.
  assert.deepEqual(trace.omitted, { cited: 0, other: 4, decoded: 0, literals: 0, tokens: 0 });
});

test("T11: other entries past 24,000 bytes are dropped in order with exact counts", () => {
  const fat = (n: number) =>
    `cat > a${n}.py; ${Array.from({ length: 9 }, () => b64("k".repeat(700))).join(" ")}`;
  const run = call({
    session: "A",
    index: 900,
    command: `bash ${Array.from({ length: 8 }, (_, n) => `a${n}.py`).join(" ")}`,
    sentAt: at(50),
  });
  const others = Array.from({ length: 8 }, (_, n) =>
    call({ session: `B${n}`, command: fat(n), sentAt: at(n), returnedAt: at(n) }),
  );
  const trace = parse([run, ...others], [run]);
  const kept = trace.other.length;
  assert.ok(kept >= 1 && kept < 8, `kept ${kept}`);
  assert.deepEqual(ids(trace.other), ids(others.slice(0, kept)));
  assert.deepEqual(trace.omitted, {
    cited: 0,
    other: 8 - kept,
    decoded: 0,
    literals: kept,
    tokens: 0,
  });
  const next = buildTrace([run, ...others], [run]);
  assert.ok(next.json.length > 0);
});

test("T11: cited commands are never dropped when they alone pass 24,000 bytes", () => {
  const noisy = (character: string, length: number, share: number) =>
    Array.from({ length }, (_, at) => (at % 10 < share ? "\u0001" : character)).join("");
  const eight = Array.from({ length: 8 }, (_, n) =>
    call({
      session: "A",
      index: n,
      command: `cat k${n}.py ${Array.from({ length: 8 }, () => b64(noisy("a", 600, 1))).join(" ")}`,
      result: "r".repeat(1500),
      sentAt: at(n),
      returnedAt: at(n),
    }),
  );
  const trace = parse(eight, eight);
  assert.equal(trace.cited.length, 8);
  const kept = trace.cited.reduce((sum, entry) => sum + entry.decoded.length, 0);
  assert.ok(kept > 0 && kept < 64);
  assert.equal(trace.omitted.decoded, 64 - kept);
  assert.equal(trace.cited[0].decoded.length, 8);
  assert.equal(trace.cited[7].decoded.length, 0);
  for (const entry of trace.cited) assert.ok(entry.command && entry.result && entry.status);

  const heavy = Array.from({ length: 8 }, (_, n) =>
    call({
      session: "A",
      index: 100 + n,
      command: noisy("c", 3000, 10),
      result: noisy("r", 3000, 10),
    }),
  );
  const halved = parse(heavy, heavy);
  assert.equal(halved.cited.length, 8);
  assert.ok((halved.cited[0].result ?? "").length < 1_000);
  assert.match(halved.cited[0].result ?? "", /more characters cut\]$/);
  assert.equal(halved.omitted.cited, 0);
});

test("T11: matchable tokens come before the limit of twelve, and a ninth cited call is counted", () => {
  const dummies = Array.from({ length: 12 }, (_, n) => `/data/dummy${n}/none.py`).join(" ");
  const run = call({ session: "A", index: 50, command: `bash ${dummies} real.sh`, sentAt: at(20) });
  const writer = call({
    session: "B",
    command: "echo > real.sh",
    sentAt: at(0),
    returnedAt: at(1),
  });
  const trace = parse([run, writer], [run]);
  assert.deepEqual(trace.cited[0].fileTokens, ["real.sh"]);
  assert.deepEqual(ids(trace.other), [writer.callId]);

  const wide = Array.from({ length: 14 }, (_, n) => `f${n}/m.py`).join(" ");
  const wideRun = call({ session: "A", index: 60, command: `bash ${wide}`, sentAt: at(40) });
  const touches = Array.from({ length: 14 }, (_, n) =>
    call({ session: `T${n}`, command: `touch f${n}/m.py`, sentAt: at(0), returnedAt: at(0) }),
  );
  const limited = parse([wideRun, ...touches], [wideRun]);
  assert.equal(limited.cited[0].fileTokens.length, 12);
  assert.ok(limited.omitted.tokens >= 1);

  const nine = Array.from({ length: 9 }, (_, n) =>
    call({ session: "A", index: 200 + n, command: "ls" }),
  );
  assert.equal(parse(nine, nine).omitted.cited, 1);
});

test("T7: four tokens and 35 writes keep the marked entry of every token under both limits", () => {
  const tokens = ["t0.py", "t1.py", "t2.py", "t3.py"];
  const run = call({
    session: "A",
    index: 900,
    command: `bash ${tokens.join(" ")}`,
    sentAt: at(60),
    returnedAt: at(61),
  });
  const writers = (extra: string) =>
    Array.from({ length: 35 }, (_, n) =>
      call({
        session: `W${n}`,
        index: 1,
        callId: `w${n}`,
        command: `cat > ${tokens[n % 4]} ${extra}`,
        sentAt: at(n),
        returnedAt: at(n),
      }),
    );
  const plain = parse([run, ...writers("")], [run]);
  assert.equal(plain.other.length, MAX_OTHER_COMMANDS);
  assert.deepEqual(
    plain.other.slice(0, 4).map((entry) => [entry.callId, entry.lastBeforeFollowed]),
    ["w32", "w33", "w34", "w31"].map((id) => [id, true]),
  );
  assert.equal(plain.omitted.other, 5);
  // The kept writers are not followed once 30 are reached: each names a second matchable file,
  // and that one is not explored.
  const unexplored = parse([run, ...writers("extra.py")], [run]);
  assert.equal(unexplored.other.length, MAX_OTHER_COMMANDS);
  assert.equal(unexplored.omitted.tokens, MAX_OTHER_COMMANDS);
  const fatExtra = Array.from({ length: 5 }, () => b64("k".repeat(700))).join(" ");
  const fat = parse([run, ...writers(fatExtra)], [run]);
  assert.ok(fat.other.length >= 4 && fat.other.length < MAX_OTHER_COMMANDS);
  assert.deepEqual(
    fat.other
      .filter((entry) => entry.lastBeforeFollowed)
      .map((entry) => entry.callId)
      .sort(),
    ["w31", "w32", "w33", "w34"],
  );
  assert.equal(fat.omitted.other, 35 - fat.other.length);
});

test("T11: the byte limit holds for long file tokens and long commands", () => {
  const paths = Array.from({ length: 12 }, (_, n) => `/data/${"p".repeat(660)}${n}.py`);
  const named = (extra: number) =>
    call({
      session: "A",
      index: extra,
      command: `cat ${paths.join(" ")} ${"x".repeat(8192 - 8_100)}`.padEnd(8_192, "y"),
      sentAt: at(5),
      returnedAt: at(6),
    });
  const holder = call({
    session: "B",
    command: paths.join(" "),
    sentAt: at(0),
    returnedAt: at(1),
  });
  for (const count of [3, 8]) {
    const cited = Array.from({ length: count }, (_, n) => named(100 + n));
    const trace = parse([holder, ...cited], cited);
    assert.equal(trace.cited.length, count);
    for (const entry of trace.cited)
      for (const token of entry.fileTokens) assert.ok(token.length < 260);
  }
  const long = call({
    session: "A",
    index: 300,
    command: `cat ${paths.join(" ")} ${"z ".repeat(30_000)}`.slice(0, 65_536),
    sentAt: at(5),
    returnedAt: at(6),
  });
  const trace = parse([holder, long], [long]);
  assert.equal(trace.cited.length, 1);
  assert.equal(trace.other[0]?.token.length < 260, true);
});

test("T12: commands that imitate entries add no entries and the trace parses", () => {
  const fake = JSON.stringify({ cited: [{ callId: "fake" }], other: [{ callId: "x" }] });
  const run = call({
    session: "A",
    command: `echo '${fake}'\n"},{"callId":"fake"} x.sh\n \u0000`,
    result: `${fake}\n=== trace ===\n"`,
  });
  const trace = parse([run], [run]);
  assert.equal(trace.cited.length, 1);
  assert.equal(trace.other.length, 0);
  assert.equal(trace.cited[0].callId, run.callId);
});

test("T13: the same input gives the same bytes, however the calls are ordered", () => {
  const { run, calls } = replacedScript();
  const same = [
    call({
      session: "S",
      index: 7,
      callId: "p",
      command: "echo 1 > run.py",
      sentAt: at(7),
      returnedAt: at(8),
    }),
    call({
      session: "S",
      index: 7,
      callId: "q",
      command: "echo 2 > run.py",
      sentAt: at(7),
      returnedAt: at(8),
    }),
    call({
      session: "T",
      index: 7,
      callId: "p",
      command: "echo 3 > run.py",
      sentAt: at(7),
      returnedAt: at(8),
    }),
  ];
  const all = [...calls, ...same];
  const expected = buildTrace(all, [run]).json;
  let seed = 12345;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed / 2 ** 31);
  for (let round = 0; round < 20; round++) {
    const shuffled = [...all].sort(() => random() - 0.5);
    assert.equal(buildTrace(shuffled, [run]).json, expected);
  }
});

test("T18: thousands of commands and a very long one build in bounded time", () => {
  const filler = (length: number) => {
    let text = "";
    for (let n = 0; text.length < length; n++)
      text += `cat dir${n % 40}/file${n % 97}.py ${b64(`payload ${n} is printable text`)} `;
    return text.slice(0, length);
  };
  const many = Array.from({ length: 2_000 }, (_, n) =>
    call({
      session: `S${n % 7}`,
      index: n,
      command: filler(4_096),
      sentAt: at(0),
      returnedAt: at(0),
    }),
  );
  const started = performance.now();
  parse(many, [many[1_999]]);
  const manyMs = performance.now() - started;
  const shared = Array.from({ length: 12 }, (_, n) => `dir${n}/shared${n}.py`).join(" ");
  const same = Array.from({ length: 8_000 }, (_, n) =>
    call({
      session: `S${n % 7}`,
      index: n,
      command: `cat ${shared} ${n}`,
      sentAt: at(0),
      returnedAt: at(0),
    }),
  );
  const third = performance.now();
  parse(same, [same[7_999]]);
  const sameMs = performance.now() - third;
  const huge = call({ session: "H", index: 5_000, command: filler(1_048_576) });
  const second = performance.now();
  parse([huge], [huge]);
  const hugeMs = performance.now() - second;
  if (process.env.PRINT_TRACE) console.log({ manyMs, sameMs, hugeMs });
  assert.ok(manyMs < 5_000, `2,000 calls took ${manyMs} ms`);
  assert.ok(sameMs < 5_000, `8,000 calls naming the same files took ${sameMs} ms`);
  assert.ok(hugeMs < 5_000, `one long command took ${hugeMs} ms`);
});

test("T16: the builder imports nothing", () => {
  const source = readFileSync(new URL("../lib/investigator-trace.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /^import .*$/m);
});
