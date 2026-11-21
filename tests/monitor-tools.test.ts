import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evidenceMessages,
  MONITOR_MESSAGE_CHUNK_JSON_BYTES,
  visibleText,
} from "../lib/monitor-tools";
import type { Message } from "@earendil-works/pi-ai";
import type { MonitorSnapshot } from "../lib/types";

const snapshot = (
  messages: MonitorSnapshot["sessions"][number]["messages"] = [],
  commands: MonitorSnapshot["commands"] = [],
  operationTimes: MonitorSnapshot["operationTimes"] = [],
): MonitorSnapshot => ({
  gameId: "game-a",
  snapshotId: "capture-a",
  userId: "owner-a",
  targetSessionId: "session-a",
  revision: 7,
  omittedSessions: 0,
  isolated: false,
  sessions: [
    {
      id: "session-a",
      ordinal: 1,
      agentModel: "model-a",
      agentEffort: "medium",
      turns: 2,
      busy: false,
      reasoningVisible: true,
      messages,
    },
    ...Array.from({ length: 11 }, (_, index) => ({
      id: `session-${index + 2}`,
      ordinal: index + 2,
      agentModel: "model-a",
      agentEffort: "medium" as const,
      turns: 1,
      busy: false,
      reasoningVisible: true,
      messages: [],
    })),
  ],
  commands,
  operationTimes,
});

const message = (role: "system" | "user" | "assistant" | "toolResult", text: string) =>
  role === "assistant"
    ? {
        role,
        content: [{ type: "text" as const, text }],
        api: "openai-completions" as const,
        model: "model-a",
        provider: "openrouter",
        timestamp: 1,
        stopReason: "stop" as const,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      }
    : role === "toolResult"
      ? {
          role,
          toolCallId: "call-1",
          toolName: "sprite_exec",
          content: [{ type: "text" as const, text }],
          isError: false,
          timestamp: 1,
        }
      : { role, content: text, timestamp: 1 };

test("monitors never see the submit call or its result", () => {
  const call = {
    role: "assistant",
    content: [
      { type: "text", text: "Done with the fix." },
      { type: "toolCall", id: "c1", name: "sprite_exec", arguments: { command: "ls" } },
      { type: "toolCall", id: "c2", name: "submit", arguments: { value: "flag{secret}" } },
    ],
    timestamp: 1,
  } as unknown as Message;
  const before = structuredClone(call);
  const shown = visibleText(call, true);
  assert.equal(shown?.text.includes("submit"), false);
  assert.equal(shown?.text.includes("flag{secret}"), false);
  assert.ok(shown?.text.includes("Done with the fix."));
  assert.ok(shown?.text.includes("[tool call sprite_exec id=c1]"));
  assert.deepEqual(shown?.toolCalls, [{ id: "c1", name: "sprite_exec" }]);
  assert.deepEqual(call, before);
  const onlySubmit = {
    role: "assistant",
    content: [{ type: "toolCall", id: "c3", name: "submit", arguments: { value: "x" } }],
    timestamp: 2,
  } as unknown as Message;
  assert.equal(visibleText(onlySubmit, true), undefined);
  const result = {
    role: "toolResult",
    toolCallId: "c2",
    toolName: "submit",
    content: [{ type: "text", text: "Submitted." }],
    isError: false,
    timestamp: 3,
  } as unknown as Message;
  assert.equal(visibleText(result, true), undefined);
});

// Frozen pre-change chunking algorithm, the oracle for the linear version.
// It must not be "fixed" or optimized: the chunks are model-visible evidence.
function oracleChunkText(text: string) {
  const chunks: string[] = [];
  let chunk = "";
  for (const character of text) {
    if (
      chunk &&
      Buffer.byteLength(JSON.stringify({ text: chunk + character }), "utf8") >
        MONITOR_MESSAGE_CHUNK_JSON_BYTES
    ) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += character;
  }
  if (chunk || chunks.length === 0) chunks.push(chunk);
  return chunks;
}

const chunksOf = (text: string) =>
  evidenceMessages(snapshot(), "session-a", [message("user", text)], false).map((row) => row.text);

const jsonBytes = (text: string) => Buffer.byteLength(JSON.stringify({ text }), "utf8");

function assertChunking(text: string, label: string, compareOracle = true) {
  const chunks = chunksOf(text);
  assert.equal(chunks.join(""), text, `${label}: joined chunks`);
  chunks.forEach((chunk, index) => {
    assert.ok(
      jsonBytes(chunk) <= MONITOR_MESSAGE_CHUNK_JSON_BYTES,
      `${label}: chunk ${index} size`,
    );
    const next = chunks[index + 1];
    if (next === undefined) return;
    const first = String.fromCodePoint(next.codePointAt(0)!);
    assert.ok(
      jsonBytes(chunk + first) > MONITOR_MESSAGE_CHUNK_JSON_BYTES,
      `${label}: chunk ${index} is not maximal`,
    );
    assert.ok(
      !(/[\ud800-\udbff]$/.test(chunk) && /^[\udc00-\udfff]/.test(next)),
      `${label}: chunk ${index} splits a surrogate pair`,
    );
  });
  if (compareOracle)
    assert.deepEqual(chunks, oracleChunkText(text), `${label}: matches the pre-change chunks`);
}

const BOUNDARY_CHARACTERS = ["a", "\n", '"', "é", "€", "\u2028", "😀", "\0", "\ud800"];

test("chunking matches the pre-change algorithm at every escaped-size boundary", () => {
  const room = MONITOR_MESSAGE_CHUNK_JSON_BYTES - jsonBytes("");
  for (const character of BOUNDARY_CHARACTERS) {
    const need = jsonBytes(character) - jsonBytes("");
    for (const delta of [-1, 0, 1]) {
      const text = `${"a".repeat(room - need + delta)}${character}bb`;
      assertChunking(text, `${JSON.stringify(character)} delta ${delta}`);
    }
  }
});

test("chunking matches the pre-change algorithm on escape-dense and surrogate-edge text", () => {
  const cases: Record<string, string> = {
    quotes: '"'.repeat(5000),
    backslashes: "\\".repeat(5000),
    shortEscapes: "\n\t\r\b\f".repeat(1500),
    longEscapes: "\0\x01\x1f".repeat(1500),
    separators: "\u2028\u2029\x7f".repeat(1500),
    lowFirst: `${"a".repeat(2488)}\udc00${"a".repeat(10)}`,
    highLast: `${"a".repeat(2483)}\ud800${"a".repeat(10)}`,
    loneNextToPairs: "😀\ud800😀\udc00😀".repeat(900),
    pairsAtEdge: `${"a".repeat(2486)}😀${"a".repeat(2486)}😀`,
  };
  for (const [label, text] of Object.entries(cases)) assertChunking(text, label);
});

test("chunking matches the pre-change algorithm on seeded random text", () => {
  let state = 0x9e3779b9;
  const next = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const alphabet = [
    "a",
    "b",
    " ",
    '"',
    "\\",
    "\n",
    "\t",
    "\0",
    "\x1f",
    "\x7f",
    "é",
    "€",
    "\u2028",
    "\u2029",
    "😀",
    "\ud800",
    "\udc00",
    "\ud83d",
    "\ude00",
  ];
  for (let index = 0; index < 200; index += 1) {
    const length = 1 + Math.floor(next() * 4000);
    let text = "";
    for (let i = 0; i < length; i += 1) text += alphabet[Math.floor(next() * alphabet.length)];
    assertChunking(text, `random ${index}`, index < 20);
  }
});

test("empty text yields no rows", () => {
  assert.deepEqual(chunksOf(""), []);
});

test("a message of 1.5 million code units is chunked within two seconds", () => {
  const text = 'x"\n€😀'.repeat(250_000);
  const started = performance.now();
  const rows = evidenceMessages(snapshot(), "session-a", [message("user", text)], false);
  const elapsed = performance.now() - started;
  console.log(`1.5 M code unit chunking: ${elapsed.toFixed(0)} ms, ${rows.length} rows`);
  assert.ok(rows.length > 1);
  assert.ok(elapsed < 2000, `took ${elapsed.toFixed(0)} ms`);
});

// An instruction as the runner persists it: the player's system prompt in effect rides on it.
const instruction = (text: string, systemPrompt?: string) =>
  ({
    role: "user",
    content: [{ type: "text", text }],
    timestamp: 1,
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
  }) as Message;

test("search text carries the system prompt in effect, and an empty prompt adds nothing", () => {
  assert.match(visibleText(instruction("go", "PLAN-A"), false)!.text, /PLAN-A[\s\S]*go/);
  assert.equal(visibleText(instruction("go", ""), false)!.text, "go");
  assert.equal(visibleText(instruction("go"), false)!.text, "go");
});

const toolResult = (toolCallId: string, text: string) =>
  ({
    role: "toolResult",
    toolCallId,
    toolName: "sprite_exec",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 99,
  }) as Message;

test("T1: a tool result row carries its command's times on every chunk, and no other row does", () => {
  const times = [
    {
      sessionId: "session-a",
      toolCallId: "call-1",
      sentAt: "2026-11-20T10:00:00.250Z",
      returnedAt: "2026-11-20T10:00:01.500Z",
    },
    {
      sessionId: "session-b",
      toolCallId: "call-2",
      sentAt: "2026-11-20T11:00:00.000Z",
      returnedAt: null,
    },
  ];
  const long = "y".repeat(MONITOR_MESSAGE_CHUNK_JSON_BYTES * 2);
  const rows = evidenceMessages(
    snapshot([], [], times),
    "session-a",
    [message("user", "go"), toolResult("call-1", long), toolResult("call-2", "other session")],
    false,
  );
  const results = rows.filter((row) => row.role === "tool");
  assert.ok(results.filter((row) => row.toolCallId === "call-1").length > 1);
  for (const row of results.filter((row) => row.toolCallId === "call-1")) {
    assert.equal(row.sentAt, "2026-11-20T10:00:00.250Z");
    assert.equal(row.returnedAt, "2026-11-20T10:00:01.500Z");
  }
  // A time attaches by session and tool call id: another session's call id gives nulls.
  const other = results.find((row) => row.toolCallId === "call-2")!;
  assert.equal(other.sentAt, null);
  assert.equal(other.returnedAt, null);
  const user = rows.find((row) => row.role === "user")!;
  assert.ok(!("sentAt" in user) && !("returnedAt" in user));
});

test("T3: a null return time stays null beside a known send time", () => {
  const [row] = evidenceMessages(
    snapshot(
      [],
      [],
      [
        {
          sessionId: "session-a",
          toolCallId: "c",
          sentAt: "2026-11-20T10:00:00.000Z",
          returnedAt: null,
        },
      ],
    ),
    "session-a",
    [toolResult("c", "interrupted")],
    false,
  );
  assert.equal(row.sentAt, "2026-11-20T10:00:00.000Z");
  assert.equal(row.returnedAt, null);
});
