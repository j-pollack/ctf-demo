import assert from "node:assert/strict";
import { test } from "node:test";
import { commandOutput } from "../lib/sprites";

test("NUL characters are removed before the output is capped", () => {
  assert.equal(commandOutput("a\0b", "", 0), "ab\n[exit 0]");
  assert.equal(commandOutput("\0".repeat(20_000) + "tail", "", 0), "tail\n[exit 0]");
  assert.equal(commandOutput("x".repeat(20_000), "", 0).length, 16_000);
});
