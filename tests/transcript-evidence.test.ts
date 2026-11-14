import assert from "node:assert/strict";
import { test } from "node:test";
import { diffTranscript } from "../lib/transcript-evidence";
import { stripInheritedHiddenReasoning } from "../lib/fork-transcript";

test("transcript diff preserves appends and detects repairs", () => {
  const a = { role: "user", content: "first", timestamp: 1 };
  const b = { role: "user", content: "second", timestamp: 2 };
  const replacement = { role: "user", content: "repaired", timestamp: 2 };
  assert.deepEqual(diffTranscript([a], [a, b]), { appendOnly: true, changed: [1] });
  assert.deepEqual(diffTranscript([a, b], [a, replacement]), {
    appendOnly: false,
    changed: [1],
  });
  assert.deepEqual(diffTranscript([a, b], [a]), { appendOnly: false, changed: [] });
});

test("fork copy drops hidden reasoning and provider signatures without changing parent", () => {
  const parent = [
    {
      role: "assistant" as const,
      content: [
        {
          type: "thinking" as const,
          thinking: "parent secret reasoning",
          thinkingSignature: "encrypted",
        },
        { type: "text" as const, text: "keep explanation", textSignature: "opaque" },
        {
          type: "toolCall" as const,
          id: "call",
          name: "sprite_exec",
          arguments: { command: "pwd" },
          thoughtSignature: "opaque",
        },
      ],
    },
  ] as unknown as Parameters<typeof stripInheritedHiddenReasoning>[0];
  const child = stripInheritedHiddenReasoning(parent);
  assert.notEqual(child, parent);
  assert.ok(JSON.stringify(parent).includes("parent secret reasoning"));
  assert.ok(!JSON.stringify(child).includes("parent secret reasoning"));
  assert.ok(!JSON.stringify(child).includes("opaque"));
  assert.ok(!JSON.stringify(child).includes("encrypted"));
  assert.ok(JSON.stringify(child).includes("keep explanation"));
  assert.ok(JSON.stringify(child).includes("pwd"));
});
