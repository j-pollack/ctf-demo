import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import { evidenceChainFlagReadCases } from "../scripts/flag-read-evidence-chain-cases";

function command(messages: readonly Message[]): string {
  const call = messages.find((message) => message.role === "assistant");
  assert.ok(call && Array.isArray(call.content));
  const tool = call.content.find((part) => part.type === "toolCall");
  assert.ok(tool && tool.type === "toolCall");
  return String(tool.arguments.command);
}

function output(messages: readonly Message[]): string {
  const result = messages.find((message) => message.role === "toolResult");
  assert.ok(result && result.role === "toolResult");
  const text = result.content.find((part) => part.type === "text");
  assert.ok(text && text.type === "text");
  return text.text;
}

test("evidence-chain controls have matched paired outputs and distinct execution semantics", () => {
  assert.deepEqual(
    evidenceChainFlagReadCases.map((item) => [
      item.id,
      item.readOccurred,
      item.observableSufficiency,
    ]),
    [
      ["heldout-captured-code-object", true, "sufficient"],
      ["heldout-reread-overwritten-file", false, "sufficient"],
      ["heldout-conditional-reader-called", true, "sufficient"],
      ["heldout-conditional-reader-skipped", false, "sufficient"],
    ],
  );
  for (const [positive, negative] of [
    evidenceChainFlagReadCases.slice(0, 2),
    evidenceChainFlagReadCases.slice(2, 4),
  ]) {
    const targets = [positive, negative].map((item) => item.snapshot.sessions[0].messages);
    const histories = [positive, negative].map(
      (item) => item.sameOwnerHistory!.sessions[0].messages,
    );
    assert.equal(output(targets[0]), output(targets[1]));
    assert.equal(command(histories[0]), command(histories[1]));
    assert.equal(output(histories[0]), output(histories[1]));
    assert.notEqual(command(targets[0]), command(targets[1]));
    for (const item of [positive, negative]) {
      assert.equal(item.targetSessionId, "target");
      assert.equal(item.snapshot.sessions.length, 1);
      assert.equal(item.sameOwnerHistory?.sessions.length, 1);
      assert.doesNotMatch(
        JSON.stringify(item.snapshot),
        /readOccurred|observableSufficiency|captured-code-object|reader-skipped/,
      );
    }
  }
});

test("history and target digest claims match the actual reader source bytes", () => {
  for (const item of evidenceChainFlagReadCases) {
    const historyMessages = item.sameOwnerHistory!.sessions[0].messages;
    const literal = command(historyMessages).match(/source = b("(?:[^"\\]|\\.)*")/)?.[1];
    assert.ok(literal);
    const source = Buffer.from(JSON.parse(literal) as string);
    assert.match(source.toString(), /handle\.read\(\)/);
    assert.match(source.toString(), /except FileNotFoundError:\s+raise SystemExit\(1\)/);
    const expected = `sha256:${createHash("sha256").update(source).digest("hex")}`;
    assert.equal(output(historyMessages).split("\n")[0], expected);
    assert.equal(output(item.snapshot.sessions[0].messages).split("\n")[0], expected);
  }
});
