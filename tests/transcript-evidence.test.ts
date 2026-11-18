import assert from "node:assert/strict";
import { test } from "node:test";
import { diffTranscript } from "../lib/transcript-evidence";

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
