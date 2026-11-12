import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { FLAG_READ_MONITOR_VERSION } from "../lib/control";
import { FLAG_READ_SYSTEM_PROMPT } from "../lib/monitor-evidence";
import { resolveFlagReadPolicy } from "../lib/flag-read-policy";

const digest = (prompt: string) => createHash("sha256").update(prompt).digest("hex");

test("current flag-read policy preserves the production prompt and version", () => {
  const current = resolveFlagReadPolicy();
  assert.equal(current, resolveFlagReadPolicy("current"));
  assert.ok(Object.isFrozen(current));
  assert.deepEqual(Object.keys(current).sort(), [
    "monitorVersion",
    "promptHash",
    "searchStrategy",
    "systemPrompt",
  ]);
  assert.equal(current.searchStrategy, "current");
  assert.equal(current.monitorVersion, FLAG_READ_MONITOR_VERSION);
  assert.equal(current.systemPrompt, FLAG_READ_SYSTEM_PROMPT);
  assert.equal(current.promptHash, digest(FLAG_READ_SYSTEM_PROMPT));
  assert.equal(
    current.promptHash,
    "8d68e174bdcc1e2eb103eeda6dedbaf9fe48265ec19a8b92073eb877e5c7ef15",
  );
});

test("focused guidance appends one fixed strategy without changing the read policy", () => {
  const current = resolveFlagReadPolicy("current");
  const focused = resolveFlagReadPolicy("focused");
  assert.ok(Object.isFrozen(focused));
  assert.equal(focused.searchStrategy, "focused");
  assert.equal(focused.monitorVersion, "investigator-v8-glm53-jev114-focused-search-experiment");
  assert.ok(focused.systemPrompt.startsWith(`${current.systemPrompt}\n\n`));
  assert.match(focused.systemPrompt, /initial target evidence/i);
  assert.match(focused.systemPrompt, /concrete artifact/i);
  assert.match(focused.systemPrompt, /read.*canonical/i);
  assert.match(focused.systemPrompt, /repaired/i);
  assert.match(focused.systemPrompt, /incomplete|partial/i);
  assert.notEqual(focused.promptHash, current.promptHash);
  assert.equal(focused.promptHash, digest(focused.systemPrompt));
  assert.equal(
    focused.promptHash,
    "fd0c2f212766da426567423ab4c9efd919c01314825c17004a4d202a9dbc1efe",
  );
  assert.throws(() => resolveFlagReadPolicy("custom" as "current"), /strategy/i);
});
