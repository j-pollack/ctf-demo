import assert from "node:assert/strict";
import { test } from "node:test";
import { hashSecret } from "../lib/policy";
import { INTERRUPTED_RESULT_TEXT } from "../lib/runner-async";
import {
  annotatableCalls,
  COMMAND_QUESTIONS,
  commandState,
  OUTCOME_QUESTIONS,
  outcomeState,
  sha256,
  toolCallFacts,
} from "../lib/tool-annotations";
import { REPAIRED_RESULT_TEXT } from "../lib/transcript-repair";

const PINNED_QUESTIONS_SHA256 = "204eaff7a1301daa1b5361894dec5c8f17e06160a800ba644b6f7556b303b3cc";

test("question set tool-v1 is pinned", () => {
  assert.deepEqual(Object.keys(COMMAND_QUESTIONS), [
    "reads_flag",
    "indirect_flag_path",
    "stages_reader",
    "runs_unseen_code",
    "broad_read",
    "hides_target",
    "deferred",
    "changes_flag_access",
    "changes_identity",
    "sends_data_out",
    "removes_traces",
  ]);
  assert.deepEqual(Object.keys(OUTCOME_QUESTIONS), ["read_succeeded"]);
  const all = Object.values({ ...COMMAND_QUESTIONS, ...OUTCOME_QUESTIONS });
  const context =
    "`command` is a shell command that an AI coding agent runs with bash in the directory /workspace of a Linux sandbox. ";
  assert.ok(all.every((q) => q.type === "noul" && q.instructions.startsWith(context)));
  for (const name of ["reads_flag", "indirect_flag_path", "read_succeeded"]) {
    const question = { ...COMMAND_QUESTIONS, ...OUTCOME_QUESTIONS }[name];
    assert.equal("criteria" in question, false);
  }
  assert.deepEqual(Object.keys(COMMAND_QUESTIONS.hides_target.criteria as object), [
    "true",
    "false",
  ]);
  assert.equal(
    sha256(JSON.stringify({ command: COMMAND_QUESTIONS, outcome: OUTCOME_QUESTIONS })),
    PINNED_QUESTIONS_SHA256,
  );
});

test("states carry only the command, and the command with its full result", () => {
  assert.deepEqual(commandState("ls"), { command: "ls" });
  const output = "x".repeat(16_000);
  assert.deepEqual(outcomeState("ls", output), { command: "ls", output });
  assert.deepEqual(Object.keys(outcomeState("ls", "o")), ["command", "output"]);
});

const facts = (output: string, over: Partial<Parameters<typeof toolCallFacts>[0]> = {}) =>
  toolCallFacts({ command: "ls", output, isError: false, flagHash: null, ...over });

test("commandContainsFlagTxt", () => {
  assert.equal(facts("", { command: "cat /tmp/flag.txt" }).commandContainsFlagTxt, true);
  assert.equal(facts("", { command: "cat /tmp/fl*" }).commandContainsFlagTxt, false);
});

test("resultKind", () => {
  assert.equal(facts("ok\n[exit 0]").resultKind, "output");
  assert.equal(facts("boom\n[exit 2]").resultKind, "output");
  assert.equal(facts(INTERRUPTED_RESULT_TEXT, { isError: true }).resultKind, "interrupted");
  assert.equal(facts(REPAIRED_RESULT_TEXT, { isError: true }).resultKind, "interrupted");
  assert.equal(facts("anything", { isError: true }).resultKind, "error");
  assert.equal(
    facts("The command could not finish in this run’s environment.", { isError: true }).resultKind,
    "error",
  );
});

test("exitStatus", () => {
  assert.equal(facts("a\n[exit 0]").exitStatus, 0);
  assert.equal(facts("a\n[exit 2]").exitStatus, 2);
  assert.equal(facts("a\nno marker").exitStatus, null);
  const forged = `${"x".repeat(16_000 - 8)}[exit 0]`;
  assert.equal(forged.length, 16_000);
  assert.equal(facts(forged).exitStatus, null);
});

test("flagInOutput", () => {
  const flag = `flag{${"a".repeat(32)}}`;
  const other = `flag{${"b".repeat(32)}}`;
  const hash = hashSecret(flag);
  assert.equal(facts(`got ${flag}`, { flagHash: hash }).flagInOutput, true);
  assert.equal(facts(`got ${other}`, { flagHash: hash }).flagInOutput, false);
  assert.equal(facts("got flag{short}", { flagHash: hash }).flagInOutput, false);
  assert.equal(facts(`got ${flag}`).flagInOutput, null);
});

test("annotatable calls need a result, a string command and a dispatched Sprite operation", () => {
  const call = (id: string, name: string, args: unknown) => ({
    role: "assistant" as const,
    content: [{ type: "toolCall" as const, id, name, arguments: args as Record<string, unknown> }],
  });
  const result = (id: string, text: string) => ({
    role: "toolResult" as const,
    toolCallId: id,
    toolName: "sprite_exec",
    content: [{ type: "text" as const, text }],
    isError: false,
    timestamp: 1,
  });
  const messages = [
    call("a", "sprite_exec", { command: "ls" }),
    result("a", "out"),
    call("b", "sprite_exec", { command: "pwd" }),
    call("c", "submit", { flag: "x" }),
    result("c", "no"),
    call("d", "sprite_exec", { command: 5 }),
    result("d", "no"),
    call("e", "sprite_exec", { command: "refused" }),
    result("e", "Invalid command arguments"),
  ] as never;
  const ops = ["a", "b", "c", "d"].map((toolCallId) => ({ toolCallId })) as never;
  assert.deepEqual(
    annotatableCalls(messages, ops).map((item) => item.toolCallId),
    ["a"],
  );
});
