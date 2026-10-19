import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import { forkBeforeLastInstruction } from "../lib/fork-transcript";
import type { GameEvent } from "../lib/types";

const system = { role: "system", content: "", sections: { preamble: "p" }, timestamp: 1 };
const user = (text: string) => ({ role: "user", content: text, timestamp: 2 });
const assistant = (text: string) => ({
  role: "assistant",
  content: [
    { type: "thinking", thinking: `plan ${text}` },
    { type: "text", text },
  ],
  model: "m",
  stopReason: "stop",
  timestamp: 3,
});
const blockedTurn = [
  {
    role: "assistant",
    content: [{ type: "toolCall", id: "b", name: "sprite_exec", arguments: { command: "cat" } }],
    model: "m",
    stopReason: "toolUse",
    timestamp: 4,
  },
  {
    role: "toolResult",
    toolCallId: "b",
    toolName: "sprite_exec",
    content: [{ type: "text", text: "Blocked" }],
    isError: true,
    timestamp: 5,
  },
];
const messages = [
  system,
  user("one"),
  assistant("first"),
  user("two"),
  ...blockedTurn,
] as Message[];
const events: GameEvent[] = [
  { id: 10, kind: "user", text: "one", checkpoint: "v1" },
  { id: 11, kind: "agent", text: "first", turn: 1 },
  { id: 12, kind: "user", text: "two", checkpoint: "v2" },
  { id: 13, kind: "agent", text: "", turn: 2, command: "cat" },
  { id: 14, kind: "monitor", text: "no", decision: "block", turn: 2 },
];

test("the cut keeps everything before the last instruction and names what was dropped", () => {
  const cut = forkBeforeLastInstruction(messages, events);
  assert.deepEqual(cut.messages, messages.slice(0, 3));
  assert.deepEqual(cut.events, events.slice(0, 2));
  assert.equal(cut.instruction, "two");
  assert.equal(cut.checkpoint, "v2");
  assert.equal(cut.userEventId, 12);
});

test("a first instruction leaves only the system message", () => {
  const first = forkBeforeLastInstruction([system, user("one"), ...blockedTurn] as Message[], [
    { id: 1, kind: "user", text: "one", checkpoint: "v1" },
    ...events.slice(3),
  ]);
  assert.deepEqual(first.messages, [system]);
  assert.deepEqual(first.events, []);
  assert.equal(first.checkpoint, "v1");
});

test("an array-content user message is matched by its text", () => {
  const parts = [system, { role: "user", content: [{ type: "text", text: "one" }], timestamp: 2 }];
  const cut = forkBeforeLastInstruction(parts as Message[], [
    { id: 1, kind: "user", text: "one", checkpoint: "v9" },
  ]);
  assert.equal(cut.instruction, "one");
});

test("a history that cannot be matched to a checkpoint is refused", () => {
  const bad: [Message[], GameEvent[]][] = [
    [[system] as Message[], events],
    [messages, events.filter((event) => event.kind !== "user")],
    [messages, events.map((e) => (e.id === 12 ? { ...e, text: "other" } : e))],
    [messages, events.map((e) => (e.id === 12 ? { ...e, checkpoint: undefined } : e))],
  ];
  for (const [m, e] of bad) assert.throws(() => forkBeforeLastInstruction(m, e), /safely forked/);
});
