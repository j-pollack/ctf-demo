import { test } from "node:test";
import assert from "node:assert/strict";
import { GameError } from "../lib/policy";
import {
  collectStream,
  diagnosticText,
  getModel,
  lostToolCallShape,
  providerTranscript,
  providerErrorDetails,
  reasoningParam,
  reasoningText,
  type AgentDelta,
} from "../lib/inference";

test("reasoning parameters default to the pinned player effort", () => {
  const reasoner = { reasoning: true };
  assert.deepEqual(reasoningParam(reasoner), { effort: "low", exclude: false });
  assert.deepEqual(reasoningParam(reasoner, "low"), { effort: "low", exclude: false });
  assert.deepEqual(reasoningParam(reasoner, "medium"), { effort: "medium", exclude: false });
  assert.deepEqual(reasoningParam(reasoner, "high"), { effort: "high", exclude: false });
  // A model without reasoning support sends no reasoning parameter at all.
  assert.equal(reasoningParam({ reasoning: false }), undefined);
});

test("provider diagnostics retain rate-limit evidence and redact credentials and flags", () => {
  const previous = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-private-key";
  try {
    const response = new Response(null, {
      status: 429,
      headers: { "x-request-id": "provider-request", "retry-after": "12" },
    });
    const details = providerErrorDetails(response, {
      error: {
        code: 429,
        message: "Provider rate limit test-private-key flag{secret}",
        metadata: {
          provider_name: "Test provider",
          limit_source: "upstream_provider_shared_pool",
          provider_code: "TooManyRequests",
          remedy_hint: "Retry shortly",
          headers: { "X-RateLimit-Remaining": "0" },
          raw: JSON.stringify({
            error: { message: "Quota exceeded test-private-key flag{secret}" },
            request: { messages: ["private transcript"] },
          }),
        },
      },
    });
    assert.equal(details.provider, "Test provider");
    assert.equal(details.limitSource, "upstream_provider_shared_pool");
    assert.equal(details.providerCode, "TooManyRequests");
    assert.equal(details.headers["retry-after"], "12");
    assert.equal(details.headers["x-ratelimit-remaining"], "0");
    assert.equal(details.upstreamMessage, "Quota exceeded [redacted] [redacted flag]");
    assert.doesNotMatch(
      JSON.stringify(details),
      /test-private-key|flag\{secret\}|private transcript/,
    );
    assert.equal(diagnosticText("Bearer other-private-token"), "Bearer [redacted]");
    assert.equal(diagnosticText("x".repeat(3000))?.length, 2000);
    assert.equal(providerErrorDetails(response, null).message, undefined);
    assert.equal(
      providerErrorDetails(response, {
        error: { metadata: { raw: "<html>unstructured body</html>" } },
      }).upstreamMessage,
      undefined,
    );
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
  }
});

test("an agent model without reasoning support is rejected", async () => {
  // In MODELS, so getModel reaches the reasoning check.
  const noReasoningModel = "qwen/qwen3.8-flash";
  const previous = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      data: [
        {
          id: noReasoningModel,
          context_length: 100000,
          pricing: { prompt: "0.000001", completion: "0.000002" },
          supported_parameters: ["tools"],
        },
      ],
    });
  try {
    await assert.rejects(() => getModel(noReasoningModel), /does not support readable reasoning/);
  } finally {
    globalThis.fetch = previous;
  }
});

// Splits the SSE text at arbitrary byte offsets, including inside multi-byte characters.
const sse = (text: string, cuts: number[]) => {
  const bytes = new TextEncoder().encode(text);
  const edges = [0, ...cuts, bytes.length];
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 1; i < edges.length; i++)
        controller.enqueue(bytes.slice(edges[i - 1], edges[i]));
      controller.close();
    },
  });
};
const frame = (chunk: unknown) => `data: ${JSON.stringify(chunk)}\n\n`;

test("a streamed completion rebuilds the non-streaming shape and reports deltas in order", async () => {
  const text = [
    ": OPENROUTER PROCESSING\n\n",
    frame({
      id: "gen-1",
      choices: [
        {
          delta: {
            reasoning: "Think ",
            reasoning_details: [{ type: "reasoning.text", text: "Think ", index: 0, format: "x" }],
          },
        },
      ],
    }),
    frame({
      id: "gen-1",
      choices: [
        {
          delta: {
            reasoning: "héré",
            reasoning_details: [
              { type: "reasoning.text", text: "héré", index: 0, signature: "sig" },
            ],
          },
        },
      ],
    }),
    frame({ id: "gen-1", choices: [{ delta: { content: "Running ls" } }] }),
    frame({
      id: "gen-1",
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call-1",
                type: "function",
                function: { name: "sprite_exec", arguments: '{"comm' },
              },
            ],
          },
        },
      ],
    }),
    frame({
      id: "gen-1",
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'and":"ls"}' } }] } }],
    }),
    frame({
      id: "gen-1",
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 1,
                id: "call-2",
                type: "function",
                function: { name: "submit", arguments: '{"value":""}' },
              },
            ],
          },
        },
      ],
    }),
    frame({ id: "gen-1", choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
    frame({
      id: "gen-1",
      choices: [],
      usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12, cost: 0.001 },
    }),
    "data: [DONE]\r\n\r\n",
  ].join("");
  const bytes = new TextEncoder().encode(text).length;
  for (const cuts of [
    [],
    [3, 40, 41, 150, 151, 152, bytes - 2],
    Array.from({ length: bytes - 1 }, (_, i) => i + 1),
  ]) {
    const deltas: AgentDelta[] = [];
    const ids: string[] = [];
    const data = await collectStream(
      sse(text, cuts),
      (delta) => {
        assert.deepEqual(ids, ["gen-1"], "the generation id is saved before any delta");
        deltas.push(delta);
      },
      async (id) => ids.push(id),
    );
    assert.deepEqual(ids, ["gen-1"]);
    assert.deepEqual(deltas, [
      { reasoning: "Think " },
      { reasoning: "héré" },
      { text: "Running ls" },
      { calls: [{ index: 0, name: "sprite_exec", arguments: '{"comm' }] },
      { calls: [{ index: 0, arguments: 'and":"ls"}' }] },
      { calls: [{ index: 1, name: "submit", arguments: '{"value":""}' }] },
    ]);
    assert.equal(data.id, "gen-1");
    assert.deepEqual(data.usage, {
      prompt_tokens: 5,
      completion_tokens: 7,
      total_tokens: 12,
      cost: 0.001,
    });
    const [choice] = data.choices;
    assert.equal(choice.finish_reason, "tool_calls");
    assert.equal(choice.message.reasoning, "Think héré");
    assert.equal(choice.message.content, "Running ls");
    assert.deepEqual(choice.message.reasoning_details, [
      { type: "reasoning.text", text: "Think héré", index: 0, format: "x", signature: "sig" },
    ]);
    assert.deepEqual(choice.message.tool_calls, [
      {
        id: "call-1",
        type: "function",
        function: { name: "sprite_exec", arguments: '{"command":"ls"}' },
      },
      { id: "call-2", type: "function", function: { name: "submit", arguments: '{"value":""}' } },
    ]);
  }
});

test("detail-only reasoning still streams, and a mid-stream error or cut-off leaves no usage", async () => {
  const deltas: AgentDelta[] = [];
  const errored = await collectStream(
    sse(
      frame({
        id: "gen-2",
        choices: [
          { delta: { reasoning_details: [{ type: "reasoning.text", text: "Only details" }] } },
        ],
      }) +
        frame({
          id: "gen-2",
          error: { code: 502, message: "upstream" },
          choices: [{ delta: {}, finish_reason: "error" }],
        }),
      [],
    ),
    (delta) => deltas.push(delta),
    async () => {},
  );
  assert.deepEqual(deltas, [{ reasoning: "Only details" }]);
  assert.deepEqual(errored.error, { code: 502, message: "upstream" });
  assert.equal(errored.usage, undefined);
  // A stream that stops without a final chunk, and without a trailing newline.
  const cut = await collectStream(
    sse(`data: ${JSON.stringify({ id: "gen-3", choices: [{ delta: { content: "par" } }] })}`, []),
    () => {},
    async () => {},
  );
  assert.equal(cut.id, "gen-3");
  assert.equal(cut.choices[0].message.content, "par");
  assert.equal(cut.usage, undefined);
  assert.equal(cut.choices[0].finish_reason, null);
});

// Emits chunks on a schedule; never closes unless `close` is set.
const timed = (steps: { after: number; text: string }[], close: boolean) =>
  new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const step of steps) {
        await new Promise((resolve) => setTimeout(resolve, step.after));
        controller.enqueue(new TextEncoder().encode(step.text));
      }
      if (close) controller.close();
    },
  });

test("S7: the agent's stream stall keeps its message, and keep-alives count as progress", async () => {
  const first = frame({ id: "gen-4", choices: [{ delta: { reasoning: "a" } }] });
  const started = Date.now();
  await assert.rejects(
    collectStream(
      timed([{ after: 0, text: first }], false),
      () => {},
      async () => {},
      40,
    ),
    /stopped responding/,
  );
  assert.ok(Date.now() - started < 1000);
  // Seven keep-alives 20ms apart outlast a 40ms idle limit without tripping it.
  const kept = await collectStream(
    timed(
      [
        { after: 0, text: first },
        ...Array.from({ length: 7 }, () => ({ after: 20, text: ": OPENROUTER PROCESSING\n\n" })),
        { after: 20, text: frame({ id: "gen-4", choices: [{ delta: { content: "done" } }] }) },
      ],
      true,
    ),
    () => {},
    async () => {},
    40,
  );
  assert.equal(kept.choices[0].message.content, "done");
});

test("a cut-off turn with nothing left to send goes back as empty content, not null", () => {
  const turn = (stopReason: string, content: object[]) =>
    ({ role: "assistant", content, stopReason, model: "m" }) as never;
  const sent = (message: never) =>
    (providerTranscript([message], "m").messages[0] as { content: unknown }).content;
  assert.equal(sent(turn("length", [])), "");
  // Every other shape keeps its content.
  assert.equal(sent(turn("stop", [])), null);
  assert.equal(
    sent(turn("length", [{ type: "thinking", thinking: "Cut.", thinkingSignature: "[]" }])),
    null,
  );
  assert.equal(sent(turn("length", [{ type: "text", text: "Partial." }])), "Partial.");
  assert.equal(
    sent(turn("length", [{ type: "toolCall", id: "c", name: "t", arguments: {} }])),
    null,
  );
});

test("a stalled stream fails with the message the caller names, and 504", async () => {
  const stalled = () =>
    collectStream(
      timed([{ after: 0, text: frame({ id: "gen-5", choices: [{ delta: {} }] }) }], false),
      () => {},
      async () => {},
      40,
      "The investigator's model stopped responding.",
    );
  await assert.rejects(stalled(), (error: GameError) => {
    assert.equal(error.message, "The investigator's model stopped responding.");
    assert.equal(error.status, 504);
    return true;
  });
});

test("reasoning text comes from the reasoning string or text details, never undefined", () => {
  assert.equal(reasoningText({ reasoning: "plain", reasoning_details: [{ type: "x" }] }), "plain");
  assert.equal(reasoningText({ reasoning_details: [{ type: "reasoning.text" }] }), "");
  assert.equal(
    reasoningText({
      reasoning_details: [
        { type: "reasoning.text", text: "a" },
        { type: "reasoning.encrypted", data: "z" },
        { type: "reasoning.text", text: "b" },
      ],
    }),
    "a\nb",
  );
  assert.equal(reasoningText({}), "");
});

test("a chunk that cannot be handled cancels the stream and rethrows", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: {not json\n\n"));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    collectStream(
      body,
      () => {},
      async () => {},
    ),
    SyntaxError,
  );
  assert.equal(cancelled, true);
  // A failing first-chunk id write is a handler failure too.
  cancelled = false;
  const identified = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frame({ id: "gen-6", choices: [] })));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    collectStream(
      identified,
      () => {},
      async () => {
        throw new Error("id write failed");
      },
    ),
    /id write failed/,
  );
  assert.equal(cancelled, true);
});

test("a monitor response that lost its tool call is described by lengths, never content", () => {
  const call = (id: string, args: string) => ({
    id,
    type: "function",
    function: { name: "query_transcripts", arguments: args },
  });
  assert.deepEqual(
    lostToolCallShape("tool_calls", {
      content: "secret words",
      reasoning: "private thoughts",
      tool_calls: [call("", '{"sql": "SELECT'), call("c2", "{}")],
    }),
    {
      finishReason: "tool_calls",
      textLength: 12,
      reasoningLength: 16,
      toolCalls: [
        { index: 0, hasId: false, name: "query_transcripts", argumentsLength: 15 },
        { index: 1, hasId: true, name: "query_transcripts", argumentsLength: 2 },
      ],
    },
  );
  const none = lostToolCallShape("stop", { content: "done" });
  assert.deepEqual(none, {
    finishReason: "stop",
    textLength: 4,
    reasoningLength: 0,
    toolCalls: [],
  });
  assert.doesNotMatch(JSON.stringify([none]), /done/);
  // A response cut off at the output limit is continued, whatever it holds.
  assert.equal(lostToolCallShape("length", { tool_calls: [call("c", '{"sql": "SEL')] }), undefined);
  assert.equal(lostToolCallShape("length", { reasoning: "thinking only" }), undefined);
  assert.equal(lostToolCallShape("tool_calls", { tool_calls: [call("c", "{}")] }), undefined);
});

test("the shape log cuts and redacts a tool name and shows a lost call", () => {
  const named = (name: string) => ({
    id: "c",
    type: "function",
    function: { name, arguments: "{" },
  });
  const long = lostToolCallShape("tool_calls", { tool_calls: [named("x".repeat(200))] });
  assert.equal(long?.toolCalls[0].name?.length, 64);
  const flagged = lostToolCallShape("tool_calls", { tool_calls: [named("flag{secret}")] });
  assert.equal(flagged?.toolCalls[0].name, "[redacted flag]");
  // A gap in the call indexes is a lost call and is reported as missing.
  const sparse: ReturnType<typeof named>[] = [];
  sparse[1] = { ...named("finish_investigation"), function: { name: "f", arguments: "{}" } };
  assert.deepEqual(lostToolCallShape("tool_calls", { tool_calls: sparse })?.toolCalls, [
    { index: 0, missing: true },
    { index: 1, hasId: true, name: "f", argumentsLength: 2 },
  ]);
});
