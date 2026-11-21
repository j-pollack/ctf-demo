import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_PROMPT,
  SUBMIT_TOOL_DESCRIPTION,
  agentPrompt,
  hasSecret,
  makeSecret,
  inputCeiling,
} from "../lib/policy";
import { repairMessages } from "../lib/runner";
import { infer, providerTranscript } from "../lib/inference";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { requestAllowance } from "../lib/games";

test("the agent prompt is only the player's text", () => {
  assert.equal(agentPrompt(""), " ");
  assert.equal(agentPrompt(" \n "), " ");
  assert.equal(agentPrompt("Be terse."), "Be terse.");
  assert.equal(AGENT_PROMPT.trim(), "");
});

test("the submit tool does not point the agent at the flag", () => {
  assert.ok(!SUBMIT_TOOL_DESCRIPTION.includes("flag"));
  assert.match(SUBMIT_TOOL_DESCRIPTION, /unless the user asks/);
});

test("flags are unique and only exact matches win", () => {
  const first = makeSecret(),
    second = makeSecret();
  assert.notEqual(first.secret, second.secret);
  assert.equal(hasSecret(`Output: ${first.secret}`, first.hash), true);
  assert.equal(hasSecret(second.secret, first.hash), false);
  assert.equal(hasSecret(first.secret.slice(0, -1), first.hash), false);
  assert.ok(inputCeiling({ prompt: "🧪" }) > 1024);
});
test("reasoning and tools survive provider replay; interrupted tool calls are repaired", () => {
  const assistant: AssistantMessage = {
    role: "assistant",
    api: "openai-completions",
    model: "test",
    provider: "openrouter",
    timestamp: 1,
    stopReason: "toolUse",
    content: [
      {
        type: "thinking",
        thinking: "I will list files.",
        thinkingSignature: '[{"type":"reasoning.text","text":"I will list files."}]',
      },
      { type: "toolCall", id: "call-1", name: "sprite_exec", arguments: { command: "ls" } },
    ],
    usage: {
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 3,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  const repaired = repairMessages([assistant]);
  assert.equal(repaired.length, 3);
  assert.equal(repaired[2].role, "toolResult");
  assert.deepEqual(repairMessages(repaired), repaired);
  const replay = providerTranscript(repaired);
  assert.deepEqual((replay.messages[1] as { reasoning_details: unknown }).reasoning_details, [
    { type: "reasoning.text", text: "I will list files." },
  ]);
  assert.equal(replay.messages[2].role, "tool");
  const switched = providerTranscript(repaired, "different-model").messages[1] as {
    reasoning_details?: unknown;
    reasoning?: unknown;
    content: string;
    tool_calls: unknown[];
  };
  assert.equal(switched.reasoning_details, undefined);
  assert.equal(switched.reasoning, undefined);
  assert.match(switched.content, /I will list files/);
  assert.equal(switched.tool_calls.length, 1);
  const legacy = repairMessages([{ role: "system", content: "", timestamp: 1 }, assistant]);
  assert.equal(legacy[0].role === "system" && legacy[0].sections?.preamble, AGENT_PROMPT);
});
test("dollar admission prices input and output separately and fits the remaining balance", () => {
  const allowance = requestAllowance(1000, 1000, 0.000001, 0.000004, 5000);
  assert.deepEqual(allowance, { maxTokens: 750, cost: 5000 });
  assert.equal(requestAllowance(1000, 1000, 0.000001, 0.000004, 2000).maxTokens, 0);
  assert.ok(requestAllowance(1000, 1000, 0.000001, 0.000004, 1999).maxTokens < 0);
  assert.throws(() => requestAllowance(1000, 1000, NaN, 0.001, 3000000));
});
test("cancelled inference stops before configuration or token reservation", async () => {
  await assert.rejects(
    () =>
      infer(
        {} as Parameters<typeof infer>[0],
        {} as Parameters<typeof infer>[1],
        [],
        AbortSignal.abort(),
      ),
    { name: "AbortError" },
  );
});

test("a custom system prompt becomes the agent preamble", () => {
  const custom = repairMessages([], "custom prompt")[0];
  assert.equal(custom.role === "system" && custom.sections?.preamble, "custom prompt");
});

test("monitorRunBudgetExempt: finalizing runs have the higher ceiling, others the lower", async () => {
  const { monitorRunBudgetExempt } = await import("../lib/games");
  const { MONITOR_OVERAGE_MICRODOLLARS } = await import("../lib/policy");
  const claim = { runBudgetExempt: true } as never;
  const past = 1_000 + MONITOR_OVERAGE_MICRODOLLARS;
  const { FINAL_REVIEW_OVERAGE_MICRODOLLARS } = await import("../lib/policy");
  const final = 1_000 + FINAL_REVIEW_OVERAGE_MICRODOLLARS;
  assert.equal(monitorRunBudgetExempt("monitor", claim, past + 5, 1_000, "finalizing"), true);
  assert.equal(monitorRunBudgetExempt("monitor", claim, final - 1, 1_000, "finalizing"), true);
  assert.equal(monitorRunBudgetExempt("monitor", claim, final, 1_000, "finalizing"), false);
  assert.equal(monitorRunBudgetExempt("monitor", claim, past, 1_000, "active"), false);
  assert.equal(monitorRunBudgetExempt("monitor", claim, past - 1, 1_000, "active"), true);
  assert.equal(monitorRunBudgetExempt("agent", claim, 0, 1_000, "finalizing"), false);
  assert.equal(monitorRunBudgetExempt("screen", claim, 0, 1_000, "finalizing"), false);
  assert.equal(monitorRunBudgetExempt("monitor", {} as never, 0, 1_000, "finalizing"), false);
  assert.equal(monitorRunBudgetExempt("monitor", undefined, 0, 1_000, "finalizing"), false);
});
