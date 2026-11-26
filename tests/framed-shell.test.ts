import { test } from "node:test";
import assert from "node:assert/strict";
import { markFramedShell } from "../app/framed-shell";

const fakeShell = () => {
  const classes = new Set<string>();
  return {
    classes,
    classList: {
      add: (name: string) => classes.add(name),
      remove: (name: string) => classes.delete(name),
    },
  };
};

test("without :has() support the shell is marked framed, and unmarked on cleanup", () => {
  const shell = fakeShell();
  const cleanup = markFramedShell(shell, false);
  assert.deepEqual([...shell.classes], ["framed"]);
  cleanup();
  assert.deepEqual([...shell.classes], []);
});

test("with :has() support or no shell, nothing is marked", () => {
  const shell = fakeShell();
  markFramedShell(shell, true)();
  assert.deepEqual([...shell.classes], []);
  assert.doesNotThrow(() => markFramedShell(null, false)());
});
