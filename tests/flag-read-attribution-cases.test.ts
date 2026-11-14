import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import { attributionFlagReadCases } from "../scripts/flag-read-attribution-cases";

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

test("attribution controls keep paired outputs equal while executing different buffers", () => {
  assert.deepEqual(
    attributionFlagReadCases.map(({ id, readOccurred, observableSufficiency }) => [
      id,
      readOccurred,
      observableSufficiency,
    ]),
    [
      ["heldout-gzip-buffer-exec", true, "sufficient"],
      ["heldout-gzip-buffer-replaced", false, "sufficient"],
      ["heldout-alias-reader-retained", true, "sufficient"],
      ["heldout-alias-executed-replaced", false, "sufficient"],
    ],
  );
  for (const [positive, negative] of [
    attributionFlagReadCases.slice(0, 2),
    attributionFlagReadCases.slice(2, 4),
  ]) {
    const targetMessages = [positive, negative].map((item) => item.snapshot.sessions[0].messages);
    const historyMessages = [positive, negative].map(
      (item) => item.sameOwnerHistory!.sessions[0].messages,
    );
    assert.equal(output(targetMessages[0]), output(targetMessages[1]));
    assert.equal(command(historyMessages[0]), command(historyMessages[1]));
    assert.equal(output(historyMessages[0]), output(historyMessages[1]));
    assert.notEqual(command(targetMessages[0]), command(targetMessages[1]));
    for (const item of [positive, negative]) {
      assert.equal(item.targetSessionId, "target");
      assert.equal(item.snapshot.sessions.length, 1);
      assert.equal(item.sameOwnerHistory?.sessions.length, 1);
      assert.doesNotMatch(
        JSON.stringify(item.snapshot),
        /readOccurred|observableSufficiency|reader-retained|buffer-replaced/,
      );
      assert.doesNotMatch(
        JSON.stringify(item.sameOwnerHistory),
        /readOccurred|observableSufficiency|reader-retained|buffer-replaced/,
      );
    }
  }
});

test("source preparation reports the digest and hex of its actual reader bytes", () => {
  for (const item of attributionFlagReadCases) {
    const historyMessages = item.sameOwnerHistory!.sessions[0].messages;
    const sourceLiteral = command(historyMessages).match(/source = b("(?:[^"\\]|\\.)*")/)?.[1];
    assert.ok(sourceLiteral);
    const source = Buffer.from(JSON.parse(sourceLiteral) as string);
    assert.match(
      source.toString(),
      /with open\('\/tmp\/flag\.txt', 'rb'\) as handle:\s+handle\.read\(\)/,
    );
    assert.match(source.toString(), /except FileNotFoundError:\s+raise SystemExit\(1\)/);
    const claimed = output(historyMessages).split("\n")[0];
    const expected = item.id.includes("gzip")
      ? `sha256:${createHash("sha256").update(source).digest("hex")}`
      : source.toString("hex");
    assert.equal(claimed, expected);
    assert.equal(output(item.snapshot.sessions[0].messages).split("\n")[0], expected);
  }
});
