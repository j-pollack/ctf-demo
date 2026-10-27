import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message } from "@earendil-works/pi-ai";
import { buildMonitorDocument, MONITOR_OUTPUT_CLIP } from "../lib/monitor-document";

const user = (content: string) => ({ role: "user", content, timestamp: 0 }) as Message;
const system = (content: string) =>
  ({ role: "system", content, timestamp: 0 }) as unknown as Message;
const agent = (command: string, thinking = "") =>
  ({
    role: "assistant",
    content: [
      ...(thinking ? [{ type: "thinking", thinking }] : []),
      { type: "toolCall", id: command, name: "sprite_exec", arguments: { command } },
    ],
  }) as unknown as Message;
const tool = (text: string) =>
  ({
    role: "toolResult",
    toolCallId: "x",
    toolName: "sprite_exec",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 0,
  }) as unknown as Message;
const options = { windowTurns: 2, includeReasoning: true };
const texts = (messages: Message[], o = options) =>
  buildMonitorDocument(messages, o).transcript.map((turn) => turn.text);

test("the window keeps the last N agent turns and the latest instruction stays outside it", () => {
  const messages = [
    user("fix bugs"),
    agent("a"),
    tool("1"),
    agent("b"),
    tool("2"),
    agent("c"),
    tool("3"),
  ];
  const doc = buildMonitorDocument(messages, { ...options, proposedCommand: "d" });
  assert.deepEqual(
    doc.transcript.map((turn) => turn.role),
    ["user", "agent", "tool", "agent", "tool"],
  );
  assert.deepEqual(texts(messages), ["fix bugs", "[sprite_exec] b", "2", "[sprite_exec] c", "3"]);
  assert.equal(doc.proposedCommand, "d");
});

test("only the most recent user message is pinned outside the window", () => {
  const messages = [user("old"), agent("a"), user("new"), agent("b"), agent("c")];
  assert.deepEqual(texts(messages, { ...options, windowTurns: 1 }), ["new", "[sprite_exec] c"]);
});

test("tool output is clipped but commands and reasoning are not", () => {
  const long = "x".repeat(MONITOR_OUTPUT_CLIP + 50);
  const doc = buildMonitorDocument([agent(long, long), tool(long)], options);
  assert.equal(doc.transcript[0].text, `${long}\n[sprite_exec] ${long}`);
  assert.equal(doc.transcript[1].text, `${"x".repeat(MONITOR_OUTPUT_CLIP)}\n…[+50 chars]`);
});

test("reasoning is excluded unless included, and system messages never appear", () => {
  const messages = [system("secret system prompt"), user("go"), agent("ls", "my plan")];
  assert.ok(texts(messages)[1].includes("my plan"));
  const hidden = texts(messages, { ...options, includeReasoning: false });
  assert.deepEqual(hidden, ["go", "[sprite_exec] ls"]);
  assert.ok(!JSON.stringify([texts(messages), hidden]).includes("secret system prompt"));
});

test("the size cap drops the oldest turns but keeps the latest instruction and proposed command", () => {
  const big = "y".repeat(30_000);
  const messages = [
    user("fix bugs"),
    agent("a" + big),
    agent("b" + big),
    agent("c" + big),
    agent("d"),
  ];
  const doc = buildMonitorDocument(messages, {
    windowTurns: 10,
    includeReasoning: true,
    proposedCommand: "next",
  });
  assert.ok(JSON.stringify(doc).length <= 60_000);
  assert.equal(doc.transcript[0].text, "fix bugs");
  assert.equal(doc.transcript.at(-1)?.text, "[sprite_exec] d");
  assert.ok(!doc.transcript.some((turn) => turn.text.startsWith("[sprite_exec] a")));
  assert.equal(doc.proposedCommand, "next");
});
