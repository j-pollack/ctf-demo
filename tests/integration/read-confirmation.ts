import assert from "node:assert/strict";
import { READ_CONFIRMATION_REQUEST } from "../../lib/monitor-evidence";

// A tool result is the confirmation when it starts with the fixed text and a blank line.
export function isConfirmation(content: unknown) {
  return typeof content === "string" && content.startsWith(`${READ_CONFIRMATION_REQUEST}\n\n`);
}

// The JSON trace that follows the fixed text.
export function confirmationTrace(content: unknown) {
  assert.ok(isConfirmation(content), "tool result starts with the fixed confirmation text");
  return JSON.parse((content as string).slice(READ_CONFIRMATION_REQUEST.length + 2)) as {
    cited: { session: string; callId: string; command: string; status: string }[];
    other: { callId: string }[];
    omitted: { cited: number; other: number };
  };
}
