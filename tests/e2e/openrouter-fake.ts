import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { completionEvents, type Completion } from "../integration/completion-stream";
import { createScreenFake } from "../integration/screen-fake";
import { AFTER_TOOL_TEXT, CONTINUE, KEYWORDS, REPLIES } from "./agent-script";
import { createMonitorFake } from "./monitor-fake";

type Handler = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const SESSION_ID = /^[0-9a-f-]{36}:agent$/;
const DEFAULT_COST = 0.0001;
const LOSE_SIGNAL_SCORE = 0.95;
const SSE = { "content-type": "text/event-stream" };

function body(init: RequestInit | undefined) {
  assert.equal(
    new Headers(init?.headers).get("authorization"),
    `Bearer ${process.env.OPENROUTER_API_KEY}`,
    "authorization header",
  );
  return JSON.parse(String(init?.body));
}

// A response whose headers arrive and whose body stays silent until the request is aborted.
function held(signal: AbortSignal | null | undefined) {
  return new Response(
    new ReadableStream({
      start(controller) {
        const fail = () => controller.error(signal?.reason ?? new Error("aborted"));
        if (signal?.aborted) fail();
        else signal?.addEventListener("abort", fail, { once: true });
      },
    }),
    { headers: SSE },
  );
}

// The three OpenRouter endpoints the run path calls, answered by a scripted agent. A request the
// script does not expect throws, and the preload records that as a violation.
export function createOpenRouterFake({ displayName }: { displayName: Handler }) {
  const screens = createScreenFake();
  const monitor = createMonitorFake(async () => {
    const { CONTEXT_QUESTION_KEYS, questionsFor } = await import("../../lib/control");
    return questionsFor(CONTEXT_QUESTION_KEYS);
  });
  let generation = 0;
  // The text screens never see the player's wording as a verdict: only the jailbreak keyword scores.
  screens.controls.scores = (kind, text) =>
    kind === "instruction" && text.includes(KEYWORDS.jailbreak)
      ? { overrides_rules: LOSE_SIGNAL_SCORE }
      : undefined;

  const models: Handler = async (_input, init) => {
    assert.ok(!init?.method || init.method === "GET", "The catalogue is read with GET");
    const { MODELS } = await import("../../lib/policy");
    // Warm what the first text screen needs, so its 2 second deadline is not spent on imports.
    await Promise.all([
      import("../../lib/text-screen"),
      import("../../lib/display-name"),
      import("../../lib/typesafe"),
    ]);
    return Response.json({
      data: MODELS.map((id) => ({
        id,
        context_length: 200_000,
        pricing: { request: "0", prompt: "0.000001", completion: "0.000002" },
        supported_parameters: ["reasoning", "tools"],
      })),
    });
  };

  const completions: Handler = async (_input, init) => {
    const { MODELS } = await import("../../lib/policy");
    const request = body(init);
    if (monitor.isInvestigation(request.session_id)) return monitor.investigate(request);
    assert.equal(request.stream, true, "A provider request must stream");
    assert.ok(MODELS.includes(request.model), `model outside the catalogue: ${request.model}`);
    assert.match(String(request.session_id), SESSION_ID, "session_id");
    assert.ok(Array.isArray(request.messages) && request.messages.length, "messages");
    assert.ok(
      request.tools?.some(
        (tool: { function?: { name?: string } }) => tool.function?.name === "sprite_exec",
      ),
      "the sprite_exec tool is offered (tools)",
    );
    // The app may end the transcript with system messages that announce tools.
    const last = request.messages.findLast(
      (message: { role: string }) => message.role !== "system",
    );
    assert.ok(last, "no message besides the system messages");
    const id = `gen-e2e-${++generation}`;
    const stream = (message: Record<string, unknown>, cost = DEFAULT_COST) => {
      const completion: Completion = {
        id,
        choices: [{ message: { role: "assistant", ...message }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost },
      };
      return new Response(completionEvents(completion).join(""), { headers: SSE });
    };
    if (last.role === "tool") return stream({ content: AFTER_TOOL_TEXT });
    assert.equal(last.role, "user", `last message role: ${last.role}`);
    assert.equal(typeof last.content, "string", "last message content");
    const asked =
      last.content === CONTINUE
        ? request.messages.findLast(
            (message: { role: string; content: unknown }) =>
              message.role === "user" &&
              typeof message.content === "string" &&
              Object.keys(REPLIES).some((word) => (message.content as string).includes(word)),
          )
        : last;
    const keyword = Object.keys(REPLIES).find((word) => asked?.content.includes(word));
    assert.ok(keyword, "the instruction carries no keyword");
    const reply = REPLIES[keyword];
    if (reply.hold) return held(init?.signal);
    return stream(
      {
        content: reply.text,
        ...(reply.command && {
          tool_calls: [
            {
              id: `call-${generation}`,
              type: "function",
              function: {
                name: "sprite_exec",
                arguments: JSON.stringify({ command: reply.command }),
              },
            },
          ],
        }),
      },
      reply.cost,
    );
  };

  const systemone: Handler = async (input, init) => {
    const [{ DISPLAY_NAME_QUESTIONS }, { TYPESAFE_MODEL }] = await Promise.all([
      import("../../lib/display-name"),
      import("../../lib/typesafe"),
    ]);
    const request = body(init);
    assert.equal(request.model, TYPESAFE_MODEL);
    if (isDeepStrictEqual(request.questions, DISPLAY_NAME_QUESTIONS))
      return displayName(input, init);
    const answered =
      (await monitor.systemone(request)) ??
      (await screens.response(request, init?.signal ?? undefined));
    assert.ok(answered, "Unexpected question set");
    return answered;
  };

  return { models, completions, systemone };
}
