import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { FLAG_READ_MONITOR_VERSION } from "../lib/control";
import { FLAG_READ_SYSTEM_PROMPT } from "../lib/monitor-evidence";
import { resolveFlagReadPolicy, flagReadPolicyForRun } from "../lib/flag-read-policy";

const digest = (prompt: string) => createHash("sha256").update(prompt).digest("hex");

test("production policy is the only selectable strategy and a frozen singleton", () => {
  const policy = resolveFlagReadPolicy();
  assert.equal(resolveFlagReadPolicy("closed-world-presumption"), policy);
  assert.ok(Object.isFrozen(policy));
  assert.ok(policy.systemPrompt.startsWith(`${FLAG_READ_SYSTEM_PROMPT}\n\n`));
  assert.match(policy.systemPrompt, /Trusted game contract/);
  assert.match(policy.systemPrompt, /fewest shared filesystems/);
  assert.match(policy.systemPrompt, /fresh, seeded runs/);
  assert.doesNotMatch(policy.systemPrompt, /Trusted evaluation contract|frozen owner transcripts/);
  assert.equal(policy.monitorVersion, "investigator-v14-glm53-jev114-presumption-digitalocean");
  assert.equal(flagReadPolicyForRun(policy.monitorVersion), policy);
});

test("every other strategy is rejected", () => {
  for (const strategy of [
    "current",
    "focused",
    "provenance",
    "read-semantics",
    "attribution",
    "evidence-chain",
    "closed-world-presumption-v1",
    "custom",
  ])
    assert.throws(
      () => resolveFlagReadPolicy(strategy as "closed-world-presumption"),
      /Invalid flag read search strategy\./,
    );
});

test("runs on any other monitor version fail closed, including the retired flag-read versions", () => {
  for (const version of [
    "unknown",
    "investigator-v7-glm53-jev114-canonical-refs-policy-delivery",
    "investigator-v8-glm53-jev114-context32k",
  ])
    assert.throws(() => flagReadPolicyForRun(version), /Unsupported flag-read monitor version\./);
});

test("production policy is pinned to its monitor version, strategy and prompt hash", () => {
  const policy = resolveFlagReadPolicy();
  assert.equal(policy.monitorVersion, FLAG_READ_MONITOR_VERSION);
  assert.equal(policy.searchStrategy, "closed-world-presumption");
  assert.equal(
    policy.promptHash,
    "2b36e1c16706456ab155fd57cd16b7151558ca933f32e89885b4e5efc880668d",
  );
  assert.equal(digest(policy.systemPrompt), policy.promptHash);
});
