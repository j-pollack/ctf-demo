import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectStream,
  diagnosticText,
  getModel,
  providerErrorDetails,
  reasoningParam,
  type AgentDelta,
} from "../lib/inference";

test("agent reasoning is effort-capped so thinking can't eat the whole answer budget", () => {
  const reasoner = { id: "z-ai/glm-5.3-flash", reasoning: true };
  // Agents always get a bounded effort, never uncapped {enabled:true} that can exhaust max_tokens;
  // medium unless the player chose otherwise.
  assert.deepEqual(reasoningParam("agent", reasoner), { effort: "medium", exclude: false });
  assert.deepEqual(reasoningParam("agent", reasoner, "low"), { effort: "low", exclude: false });
  assert.deepEqual(reasoningParam("agent", reasoner, "high"), { effort: "high", exclude: false });
  // The monitor's reasoning ignores the agent's effort.
  assert.deepEqual(reasoningParam("monitor", reasoner, "high"), { effort: "low", exclude: false });
  // A monitor that rejects reasoning:{enabled:false} gets low effort; glm-5.3-flash is one.
  assert.deepEqual(reasoningParam("monitor", reasoner), { effort: "low", exclude: false });
  // Any other monitor turns reasoning off.
  assert.deepEqual(reasoningParam("monitor", { id: "some/other-model", reasoning: true }), {
    enabled: false,
  });
  // A model without reasoning support sends no reasoning parameter at all.
  assert.equal(reasoningParam("agent", { id: "x/y", reasoning: false }), undefined);
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

test("a monitor without reasoning support is accepted, while an agent requires reasoning", async () => {
  // In MODELS, so the agent path reaches the reasoning check.
  const dualUseModel = "qwen/qwen3.8-flash";
  const previous = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      data: [
        {
          id: dualUseModel,
          context_length: 100000,
          pricing: { prompt: "0.000001", completion: "0.000002" },
          supported_parameters: ["tools", "response_format"],
        },
      ],
    });
  try {
    assert.equal((await getModel(dualUseModel, "monitor")).reasoning, false);
    await assert.rejects(
      () => getModel(dualUseModel, "agent"),
      /does not support readable reasoning/,
    );
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

test("a stream that goes silent is stopped, but keep-alives count as progress", async () => {
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
