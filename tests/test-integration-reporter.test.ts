import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import type { TestEvent } from "node:test/reporters";
import { heldOutput } from "../scripts/test-integration-reporter";

// The runner names a file as it was passed in output events and by absolute path in results.
const passing = "tests/run-format.test.ts";
const failing = "tests/run-risk.test.ts";
const output = (file: string, message: string) =>
  ({ type: "test:stdout", data: { file, message } }) as TestEvent;
const result = (type: "test:pass" | "test:fail", file: string, name: string) =>
  ({ type, data: { file: resolve(file), name, nesting: 0 } }) as TestEvent;

test("process output is shown only for a file with a failing test", async () => {
  const events = [
    output(passing, "passing file's log"),
    output(failing, "log before the failing file's first test passes"),
    result("test:pass", passing, "passing file's test"),
    result("test:pass", failing, "failing file's first test"),
    output(failing, "log before the failure"),
    result("test:fail", failing, "failing file's second test"),
    output(failing, "log after the failure"),
    output(passing, "passing file's later log"),
  ];
  const shown = [];
  for await (const event of heldOutput(events)) {
    const data = event.data as { message?: string; name?: string };
    shown.push(data.message ?? data.name);
  }
  assert.deepEqual(shown, [
    "passing file's test",
    "failing file's first test",
    "log before the failing file's first test passes",
    "log before the failure",
    "failing file's second test",
    "log after the failure",
  ]);
});
