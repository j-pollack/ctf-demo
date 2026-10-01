import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import { forkTranscript } from "../lib/fork-transcript";
import type { GameEvent } from "../lib/types";

const messages = [
  { role: "system", content: "system", timestamp: 1 },
  { role: "user", content: "first", timestamp: 2 },
  {
    role: "assistant",
    content: [
      { type: "text", text: "first" },
      { type: "text", text: "answer" },
      { type: "toolCall", id: "call", name: "sprite_exec", arguments: { command: "pwd" } },
    ],
    model: "m",
    stopReason: "toolUse",
    timestamp: 3,
  },
  {
    role: "toolResult",
    toolCallId: "call",
    toolName: "sprite_exec",
    content: [{ type: "text", text: "old output" }],
    isError: false,
    timestamp: 4,
  },
  {
    role: "assistant",
    content: [{ type: "text", text: "two" }],
    model: "m",
    stopReason: "stop",
    timestamp: 5,
  },
] as Message[];
const events: GameEvent[] = [
  { id: 1, kind: "user", text: "first" },
  { id: 2, kind: "agent", text: "first\nanswer", model: "m", turn: 1 },
  { id: 3, kind: "monitor", text: "blocked", decision: "block", turn: 1 },
  { id: 4, kind: "tool", text: "old output", turn: 1 },
  { id: 5, kind: "agent", text: "two", model: "m", turn: 2 },
];

test("fork preserves exact conversation prefix through selected assistant, not its tools", () => {
  const prefix = forkTranscript(messages, events, 2, 2);
  assert.deepEqual(prefix.messages, messages.slice(0, 3));
  assert.deepEqual(prefix.events, events.slice(0, 2));
  assert.equal(prefix.turns, 1);
  assert.equal(prefix.blocks, 0);
});

test("fork rejects an unmappable or inconsistent successful-turn boundary", () => {
  assert.throws(() => forkTranscript(messages, events, 3, 2), /safely forked/);
  assert.throws(() => forkTranscript(messages, events, 2, 3), /safely forked/);
  assert.throws(() => forkTranscript(messages, events, 2, 999), /safely forked/);
  assert.throws(
    () => forkTranscript(messages, [{ ...events[1], turn: 2 }, ...events.slice(2)], 2, 2),
    /safely forked/,
  );
  assert.throws(
    () => forkTranscript(messages, [{ ...events[1], text: "wrong" }, ...events.slice(2)], 2, 2),
    /safely forked/,
  );
  const wrongModel = messages.map((message, index) =>
    index === 2 ? { ...message, model: "other" } : message,
  ) as Message[];
  assert.throws(() => forkTranscript(wrongModel, events, 2, 2), /safely forked/);
});

test("fork block count reflects only blocked events in the inherited prefix", () => {
  assert.equal(forkTranscript(messages, events, 2, 5).blocks, 1);
});
