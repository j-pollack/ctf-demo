import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createAssistantMessageEventStream,
  Type,
  type AssistantMessage,
  type JsonObject,
  type Message,
  type Model,
} from "@earendil-works/pi-ai";
import { providerTranscript } from "../lib/inference";
import { runInvestigatorDriver } from "../lib/investigator-driver";
import type { AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import {
  createInvestigatorAgent,
  guardInvestigatorStream,
  validateReviewScope,
  type RunMonitorReviewInput,
} from "../lib/monitor-review";

const SYSTEM_PROMPT = "Review the target.";

test("the bounded investigator respects caller cancellation and expired deadlines", async () => {
  const config = {
    systemPrompt: SYSTEM_PROMPT,
    finishName: "finish",
    prepare: () => assert.fail("cancelled or expired work must not prepare an investigator"),
  };
  await assert.rejects(
    runInvestigatorDriver({ signal: AbortSignal.abort() } as never, config),
    /review was cancelled/,
  );
  await assert.rejects(
    runInvestigatorDriver({ signal: new AbortController().signal, deadlineAt: 0 } as never, config),
    /deadline expired/,
  );
});

test("D5: a call limit outside 2 to 32 is rejected before anything runs", async () => {
  const config = {
    systemPrompt: SYSTEM_PROMPT,
    finishName: "finish",
    prepare: () => assert.fail("an invalid call limit must not prepare an investigator"),
  };
  for (const callLimit of [1, 0, 33, -1, 2.5, Number.NaN])
    await assert.rejects(
      runInvestigatorDriver({ signal: new AbortController().signal, callLimit } as never, config),
      /call limit must be an integer from 2 to 32/,
    );
});

const model: Model<"openai-completions"> = {
  id: "test-investigator",
  name: "test-investigator",
  api: "openai-completions",
  provider: "openrouter",
  baseUrl: "https://example.invalid",
  input: ["text"],
  reasoning: true,
  contextWindow: 64_000,
  maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
function providerToolCall(
  name: string,
  id: string,
  args: unknown,
  second?: { name: string; id: string; args: unknown },
  stopReason: "toolUse" | "length" = "toolUse",
  reasoning?: string,
) {
  const stream = createAssistantMessageEventStream();
  const content: AssistantMessage["content"] = [
    ...(reasoning
      ? [
          {
            type: "thinking" as const,
            thinking: reasoning,
            thinkingSignature: JSON.stringify([{ type: "reasoning.text", text: reasoning }]),
          },
        ]
      : []),
    { type: "toolCall", id, name, arguments: args as JsonObject },
    ...(second
      ? [
          {
            type: "toolCall" as const,
            id: second.id,
            name: second.name,
            arguments: second.args as JsonObject,
          },
        ]
      : []),
  ];
  const message: AssistantMessage = {
    role: "assistant",
    content,
    api: model.api,
    model: model.id,
    provider: model.provider,
    timestamp: Date.now(),
    stopReason,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  stream.push({ type: "done", reason: stopReason, message });
  return stream;
}
const noopParameters = Type.Object({}, { additionalProperties: false });
function noopTool(onCall: () => void): AgentTool<typeof noopParameters> {
  return {
    name: "noop",
    label: "No-op",
    description: "Does nothing.",
    parameters: noopParameters,
    executionMode: "sequential",
    execute: async () => {
      onCall();
      return { content: [{ type: "text", text: "ok" }], details: {} };
    },
  };
}

const unconfiguredStream: StreamFn = () => {
  throw new Error("The test must set streamFunction before prompting.");
};

test("investigator stops before a thirteenth inference dispatch", async () => {
  let runtime: ReturnType<typeof createInvestigatorAgent> | undefined;
  let failure: unknown;
  let retrievalCalls = 0;
  runtime = createInvestigatorAgent(
    model,
    [noopTool(() => (retrievalCalls += 1))],
    unconfiguredStream,
    SYSTEM_PROMPT,
  );
  let providerCalls = 0;
  let admittedCalls = 0;
  runtime.streamFunction = guardInvestigatorStream(
    () => {
      providerCalls += 1;
      return providerToolCall("noop", `noop-${providerCalls}`, {});
    },
    {
      signal: new AbortController().signal,
      isStopped: () => Boolean(failure),
      onLimit: () => {
        failure ??= new Error("Investigator call limit reached.");
        runtime?.abort();
      },
      admitCall: () => {
        if (admittedCalls >= 12) return false;
        admittedCalls += 1;
        return true;
      },
    },
  );
  await runtime.prompt("Continue until the request cap stops you.");
  assert.equal(providerCalls, 12);
  assert.equal(admittedCalls, 12);
  assert.equal(retrievalCalls, 12);
  assert.match(String(failure), /call limit reached/);
});

test("context overflow is rejected before an inference dispatch", async () => {
  let runtime: ReturnType<typeof createInvestigatorAgent> | undefined;
  let failure: unknown;
  runtime = createInvestigatorAgent(model, [], unconfiguredStream, SYSTEM_PROMPT);
  let providerCalls = 0;
  let admittedCalls = 0;
  let measured: { bytes: number; limit: number } | undefined;
  runtime.streamFunction = guardInvestigatorStream(
    () => {
      providerCalls += 1;
      return providerToolCall("unused", "unused", {});
    },
    {
      signal: new AbortController().signal,
      isStopped: () => Boolean(failure),
      maxContextBytes: 48_000,
      onContextLimit: (bytes, limit) => {
        measured = { bytes, limit };
        failure = new Error(`Investigator context limit reached: ${bytes} bytes > ${limit}.`);
      },
      onLimit: () => {
        failure = new Error("call limit");
      },
      admitCall: () => {
        admittedCalls++;
        return true;
      },
    },
  );
  await runtime.prompt("x".repeat(50_000));
  assert.equal(providerCalls, 0);
  assert.equal(admittedCalls, 0);
  assert.equal(measured?.limit, 48_000);
  assert.ok((measured?.bytes ?? 0) > 48_000);
  assert.match(String(failure), /context limit reached: \d+ bytes > 48000/);
});

test("switched-model reasoning uses the provider serialization", () => {
  const reasoning = "c".repeat(27_000);
  const previous: Message = {
    role: "assistant",
    content: [
      {
        type: "thinking",
        thinking: reasoning,
        thinkingSignature: JSON.stringify([{ type: "reasoning.text", text: reasoning }]),
      },
    ],
    api: model.api,
    model: "previous-model",
    provider: model.provider,
    timestamp: Date.now(),
    stopReason: "stop",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  const context = { messages: [previous] };
  const projected = providerTranscript(context.messages, model.id);
  assert.ok(Buffer.byteLength(JSON.stringify(context.messages), "utf8") > 48_000);
  assert.ok(Buffer.byteLength(JSON.stringify(projected), "utf8") < 48_000);
  assert.match(String(projected.messages[0].content), /Previous model reasoning:/);
  assert.equal("reasoning_details" in projected.messages[0], false);
  let dispatched = 0;
  guardInvestigatorStream(
    () => {
      dispatched++;
      return providerToolCall("unused", "unused", {});
    },
    {
      signal: new AbortController().signal,
      isStopped: () => false,
      maxContextBytes: 48_000,
      admitCall: () => true,
      onLimit: () => assert.fail("call limit"),
      onContextLimit: () => assert.fail("context limit"),
    },
  )(model, context as never);
  assert.equal(dispatched, 1);
});

test("provider tool schemas count toward the context ceiling", () => {
  const context = {
    messages: [
      {
        role: "system" as const,
        content: "Review the target.",
        toolsAdded: [{ name: "large_tool", description: "d".repeat(48_000), parameters: {} }],
      },
    ],
  };
  const projected = providerTranscript(context.messages as Message[], model.id);
  assert.ok(Buffer.byteLength(JSON.stringify(projected.messages), "utf8") < 48_000);
  const bytes = Buffer.byteLength(JSON.stringify(projected), "utf8");
  assert.ok(bytes > 48_000);
  let admitted = 0;
  let dispatched = 0;
  let measured: { bytes: number; limit: number } | undefined;
  guardInvestigatorStream(
    () => {
      dispatched++;
      return providerToolCall("unused", "unused", {});
    },
    {
      signal: new AbortController().signal,
      isStopped: () => false,
      maxContextBytes: 48_000,
      admitCall: () => {
        admitted++;
        return true;
      },
      onLimit: () => assert.fail("call limit"),
      onContextLimit: (actual, limit) => {
        measured = { bytes: actual, limit };
      },
    },
  )(model, context as never);
  assert.deepEqual(measured, { bytes, limit: 48_000 });
  assert.equal(admitted, 0);
  assert.equal(dispatched, 0);
});

test("replayed reasoning is counted once in the provider context", async () => {
  let done = false;
  let failure: unknown;
  let calls = 0;
  const firstReasoning = "a".repeat(13_000);
  const secondReasoning = "b".repeat(13_000);
  const finish: AgentTool<typeof noopParameters> = {
    ...noopTool(() => {}),
    name: "finish",
    execute: async () => {
      done = true;
      return { content: [{ type: "text", text: "done" }], details: {} };
    },
  };
  const tools = [noopTool(() => {}), finish];
  const runtime = createInvestigatorAgent(model, tools, unconfiguredStream, SYSTEM_PROMPT);
  runtime.streamFunction = guardInvestigatorStream(
    (_apiModel, context) => {
      calls++;
      if (calls <= 2)
        return providerToolCall(
          "noop",
          `noop-${calls}`,
          {},
          undefined,
          "toolUse",
          calls === 1 ? firstReasoning : secondReasoning,
        );
      const raw = JSON.stringify(context.messages);
      const projected = providerTranscript(context.messages, model.id);
      const wire = JSON.stringify(projected);
      assert.ok(Buffer.byteLength(raw, "utf8") > 48_000);
      assert.ok(Buffer.byteLength(wire, "utf8") < 48_000);
      assert.equal(raw.split(firstReasoning).length - 1, 2);
      assert.equal(wire.split(firstReasoning).length - 1, 1);
      assert.equal(wire.split(secondReasoning).length - 1, 1);
      assert.equal(projected.tools?.length, tools.length);
      return providerToolCall("finish", "finish", {});
    },
    {
      signal: new AbortController().signal,
      isStopped: () => Boolean(failure || done),
      maxContextBytes: 48_000,
      onContextLimit: () => {
        failure = new Error("context limit");
      },
      onLimit: () => {
        failure = new Error("call limit");
      },
      admitCall: () => true,
    },
  );
  runtime.subscribe((event) => {
    if (event.type === "tool_execution_end" && event.toolName === "finish" && done) runtime.abort();
  });
  await runtime.prompt("Review the target with available tools.");
  assert.equal(calls, 3);
  assert.equal(failure, undefined);
  assert.ok(done);
});

test("review scope accepts only the captured target of this game and owner", () => {
  const session = { id: "session-1", messages: [] };
  const snapshot = {
    snapshotId: "snapshot-1",
    gameId: "game-1",
    userId: "owner-1",
    targetSessionId: "session-1",
    revision: 1,
    omittedSessions: 0,
    sessions: [session],
    commands: [],
  };
  const input = (overrides: Record<string, unknown> = {}, snapshotOverrides = {}) =>
    ({
      game: { id: "game-1", owner_id: "owner-1" },
      reviewId: "review-1",
      snapshot: { ...snapshot, ...snapshotOverrides },
      currentSessionId: "session-1",
      target: { kind: "transcript" },
      riskSignals: {},
      signal: new AbortController().signal,
      ...overrides,
    }) as unknown as RunMonitorReviewInput;
  const scope = validateReviewScope(input());
  assert.deepEqual(scope.target, { kind: "transcript" });
  assert.deepEqual(scope.snapshot, snapshot);
  assert.notEqual(scope.snapshot, snapshot, "the snapshot is copied");
  const mismatch = /Monitor review scope does not match the captured snapshot\./;
  assert.throws(
    () => validateReviewScope(input({}, { targetSessionId: "session-0" })),
    mismatch,
    "a historical same-owner session is not the target",
  );
  assert.throws(() => validateReviewScope(input({}, { userId: "owner-2" })), mismatch);
  assert.throws(() => validateReviewScope(input({}, { gameId: "game-2" })), mismatch);
  assert.throws(
    () => validateReviewScope(input({ target: { kind: "command" } })),
    /Invalid monitor target\./,
  );
});
