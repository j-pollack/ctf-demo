// Turns a chat completion into the server-sent events OpenRouter sends for a streamed request.
import assert from "node:assert/strict";

export type Completion = {
  id: string;
  choices: { message: Record<string, any>; finish_reason: string }[];
  usage?: Record<string, unknown>;
};

const pieces = (text: string, count: number) => {
  const size = Math.max(1, Math.ceil(text.length / count));
  return Array.from({ length: Math.ceil(text.length / size) }, (_, i) =>
    text.slice(i * size, (i + 1) * size),
  );
};

// With `split`, text, reasoning details and tool call arguments arrive in several fragments.
export function completionEvents(completion: Completion, split = false): string[] {
  const { id } = completion;
  const { message, finish_reason } = completion.choices[0];
  const deltas: Record<string, unknown>[] = [];
  if (!split) {
    deltas.push({
      ...message,
      ...(Array.isArray(message.tool_calls) && {
        tool_calls: message.tool_calls.map((call: object, index: number) => ({ ...call, index })),
      }),
    });
  } else {
    if (message.reasoning)
      for (const text of pieces(message.reasoning, 3)) deltas.push({ reasoning: text });
    // Fragments of one detail share an index. It is sent only when the reassembled detail keeps it.
    const details: Record<string, unknown>[] = message.reasoning_details ?? [];
    for (const [position, detail] of details.entries()) {
      const { text, ...rest } = detail;
      const parts = typeof text === "string" ? pieces(text, 3) : [];
      const index = detail.index ?? (details.length > 1 ? position : undefined);
      const tag = index === undefined ? {} : { index };
      deltas.push({
        reasoning_details: [{ ...rest, ...tag, ...(parts.length && { text: parts[0] }) }],
      });
      for (const part of parts.slice(1))
        deltas.push({ reasoning_details: [{ ...tag, text: part }] });
    }
    if (message.content)
      for (const text of pieces(message.content, 3)) deltas.push({ content: text });
    for (const [index, call] of (message.tool_calls ?? []).entries()) {
      deltas.push({
        tool_calls: [
          {
            index,
            id: call.id,
            type: "function",
            function: { name: call.function.name, arguments: "" },
          },
        ],
      });
      for (const part of pieces(call.function.arguments, 4))
        deltas.push({ tool_calls: [{ index, function: { arguments: part } }] });
    }
  }
  return [
    ...deltas.map((delta) => ({ id, choices: [{ delta }] })),
    { id, choices: [{ delta: {}, finish_reason }] },
    ...(completion.usage ? [{ id, choices: [], usage: completion.usage }] : []),
  ]
    .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
    .concat("data: [DONE]\n\n");
}

// A fake provider answers a streamed request only; a request without `stream: true` fails the test.
export function streamedCompletion(
  request: RequestInit | undefined,
  completion: Completion,
  options: { split?: boolean } = {},
) {
  assert.equal(JSON.parse(String(request?.body)).stream, true, "A provider request must stream");
  return new Response(completionEvents(completion, options.split).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

export function assertStreams(request: RequestInit | undefined) {
  assert.equal(JSON.parse(String(request?.body)).stream, true, "A provider request must stream");
}

// A stream that stays alive for `totalMs`, sending a keep-alive comment and a reasoning token
// every `tickMs`, and then delivers the completion. Aborting the request errors the stream.
export function slowCompletion(
  request: RequestInit | undefined,
  completion: Completion,
  { totalMs, tickMs }: { totalMs: number; tickMs: number },
) {
  assertStreams(request);
  const encoder = new TextEncoder();
  const signal = request?.signal ?? undefined;
  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for (let waited = 0; waited < totalMs; waited += tickMs) {
            const tick = { id: completion.id, choices: [{ delta: { reasoning: "thinking. " } }] };
            controller.enqueue(encoder.encode(": OPENROUTER PROCESSING\n\n"));
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(tick)}\n\n`));
            signal?.throwIfAborted();
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(resolve, tickMs);
              signal?.addEventListener(
                "abort",
                () => {
                  clearTimeout(timer);
                  reject(signal.reason);
                },
                { once: true },
              );
            });
          }
          for (const event of completionEvents(completion))
            controller.enqueue(encoder.encode(event));
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}
