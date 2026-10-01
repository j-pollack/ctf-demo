import {
  createAssistantMessageEventStream,
  getSystemMessageText,
  type Api,
  type AssistantMessage,
  type Message,
  type Model,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { setTimeout as sleep } from "node:timers/promises";
import { assertLease, reserveInference, settleInference, type GameRow } from "./games";
import { db } from "./db";
import { GameError, inputCeiling, MODELS } from "./policy";

type CatalogModel = {
  id: string;
  context_length: number;
  pricing: { prompt: string; completion: string; request?: string };
  supported_parameters: string[];
};
let catalog: { expires: number; models: CatalogModel[] } | undefined;
export async function getModel(
  id: string,
  role: "agent" | "monitor" = "agent",
): Promise<Model<"openai-completions">> {
  if (role === "agent" && !MODELS.some((model) => model === id))
    throw new GameError("Unsupported model.");
  if (!catalog || catalog.expires < Date.now()) {
    const response = await fetch("https://openrouter.ai/api/v1/models", {
      signal: AbortSignal.timeout(15000),
      cache: "no-store",
    });
    if (!response.ok) throw new Error("Model catalog is unavailable.");
    const data = await response.json();
    catalog = { expires: Date.now() + 300000, models: data.data };
  }
  const entry = catalog.models.find((model) => model.id === id);
  if (!entry || Number(entry.pricing.request ?? 0) !== 0)
    throw new GameError("The selected model is unavailable for this game.", 503);
  const reasoning = entry.supported_parameters.includes("reasoning");
  if (role === "agent" && !reasoning)
    throw new GameError(
      "The selected agent model does not support readable reasoning. Choose a different agent.",
      503,
    );
  if (!entry.supported_parameters.includes(role === "agent" ? "tools" : "response_format"))
    throw new GameError(
      `The selected ${role} model does not support the required request format.`,
      503,
    );
  const input = Number(entry.pricing.prompt) * 1e6,
    output = Number(entry.pricing.completion) * 1e6;
  if (![input, output].every((price) => Number.isFinite(price) && price > 0))
    throw new Error("Model pricing is unavailable.");
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    input: ["text"],
    reasoning,
    contextWindow: entry.context_length,
    maxTokens: 4096,
    cost: { input, output, cacheRead: input, cacheWrite: input },
  };
}

export function diagnosticText(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  let text = String(value)
    .replace(/flag\{[^}]*\}/g, "[redacted flag]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]");
  for (const [name, secret] of Object.entries(process.env))
    if (secret && /(?:KEY|TOKEN|SECRET|DATABASE_URL)/.test(name))
      text = text.split(secret).join("[redacted]");
  return text.slice(0, 2000);
}
export function providerErrorDetails(response: Response, body: unknown) {
  const object = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const error = object(object(body).error),
    metadata = object(error.metadata);
  let upstream: unknown;
  if (typeof metadata.raw === "string") {
    try {
      upstream = object(object(JSON.parse(metadata.raw)).error).message;
    } catch {
      /* Unstructured raw bodies can contain request contents; omit them. */
    }
  } else upstream = object(object(metadata.raw).error).message;
  return {
    provider: diagnosticText(metadata.provider_name),
    code: diagnosticText(error.code),
    message: diagnosticText(error.message),
    errorType: diagnosticText(metadata.error_type),
    limitSource: diagnosticText(metadata.limit_source),
    reason: diagnosticText(metadata.reason),
    providerCode: diagnosticText(metadata.provider_code ?? metadata.provider_error_code),
    remedy: diagnosticText(metadata.remedy_hint),
    upstreamMessage: diagnosticText(upstream),
    headers: Object.fromEntries(
      [
        "x-request-id",
        "x-openrouter-request-id",
        "cf-ray",
        "retry-after",
        "x-ratelimit-limit",
        "x-ratelimit-remaining",
        "x-ratelimit-reset",
      ]
        .map((name) => [
          name,
          diagnosticText(
            response.headers.get(name) ??
              Object.entries(object(metadata.headers)).find(
                ([key]) => key.toLowerCase() === name,
              )?.[1],
          ),
        ])
        .filter(([, value]) => value !== undefined),
    ),
  };
}

export function textOf(message: Message) {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}
export function reasoningOf(message: AssistantMessage) {
  return message.content
    .filter((part) => part.type === "thinking")
    .map((part) => part.thinking)
    .join("\n");
}
function retryAfter(value: string | undefined) {
  if (!value) return 0;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) {
    const seconds = Number(value);
    return Number.isFinite(seconds) ? seconds * 1000 : 0;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}
export function providerTranscript(messages: Message[], targetModel?: string) {
  const tools = new Map();
  const transcript = messages.map((message) => {
    if (message.role === "system") {
      message.toolsRemoved?.forEach((tool) => tools.delete(tool.name));
      message.toolsAdded?.forEach((tool) =>
        tools.set(tool.name, {
          type: "function",
          function: { name: tool.name, description: tool.description, parameters: tool.parameters },
        }),
      );
      return { role: "system", content: getSystemMessageText(message) };
    }
    if (message.role === "toolResult")
      return { role: "tool", tool_call_id: message.toolCallId, content: textOf(message) };
    if (message.role === "user") return { role: "user", content: textOf(message) };
    const calls = message.content.filter((part) => part.type === "toolCall");
    const thinking = message.content.find((part) => part.type === "thinking");
    const switched = targetModel !== undefined && message.model !== targetModel;
    const details = thinking?.thinkingSignature ? JSON.parse(thinking.thinkingSignature) : [];
    return {
      role: "assistant",
      content:
        switched && thinking?.thinking
          ? [`Previous model reasoning:\n${thinking.thinking}`, textOf(message)]
              .filter(Boolean)
              .join("\n\n")
          : textOf(message) || null,
      ...(calls.length
        ? {
            tool_calls: calls.map((call) => ({
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.arguments) },
            })),
          }
        : {}),
      ...(!switched && details.length
        ? { reasoning_details: details }
        : !switched && thinking?.thinking
          ? { reasoning: thinking.thinking }
          : {}),
    };
  });
  return { messages: transcript, ...(tools.size ? { tools: [...tools.values()] } : {}) };
}

// Non-streaming provider calls keep accounting and raw reasoning in one authoritative response.
export async function infer(
  game: GameRow,
  role: "agent" | "monitor",
  model: Model<"openai-completions">,
  messages: Message[],
  signal?: AbortSignal,
  onRetry?: (message: string) => void,
): Promise<AssistantMessage> {
  signal?.throwIfAborted();
  if (!process.env.OPENROUTER_API_KEY) throw new Error("Inference is not configured.");
  const payload = {
    model: model.id,
    ...providerTranscript(messages, model.id),
    session_id: `${game.id}:${role}`,
    ...(model.reasoning
      ? { reasoning: role === "agent" ? { enabled: true, exclude: false } : { enabled: false } }
      : {}),
    provider: {
      require_parameters: true,
      max_price: { prompt: model.cost.input, completion: model.cost.output },
    },
    ...(role === "monitor" ? { response_format: { type: "json_object" } } : {}),
  };
  const ceiling = inputCeiling(payload);
  if (ceiling + 4096 > model.contextWindow)
    throw new GameError(
      "This conversation is too long for the selected model. Choose a model with a larger context window.",
      400,
    );
  const reservation = await reserveInference(
    game.id,
    game.lease,
    role,
    model.id,
    ceiling,
    role === "agent" ? 4096 : 2048,
    model.cost.input / 1e6,
    model.cost.output / 1e6,
  );
  const started = Date.now(),
    context = { gameId: game.id, requestId: reservation.id, role, model: model.id };
  let settled = false;
  let knownUnbilled = false;
  let response: Response | undefined,
    providerError: ReturnType<typeof providerErrorDetails> | undefined;
  const deadline = AbortSignal.timeout(90000);
  const requestSignal = AbortSignal.any([signal ?? new AbortController().signal, deadline]);
  try {
    for (let attempt = 1; attempt <= 5; attempt++) {
      requestSignal.throwIfAborted();
      if (attempt > 1) await assertLease(game);
      requestSignal.throwIfAborted();
      knownUnbilled = false;
      response = undefined;
      providerError = undefined;
      response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ...payload, max_tokens: reservation.maxTokens }),
        signal: requestSignal,
      });
      knownUnbilled = !response.ok && [400, 401, 402, 403, 404, 422, 429].includes(response.status);
      requestSignal.throwIfAborted();
      if (response.ok) break;
      providerError = providerErrorDetails(response, await response.json().catch(() => null));
      requestSignal.throwIfAborted();
      if (response.status !== 429 || attempt === 5)
        throw new GameError(
          `Inference service returned ${response.status}. The command was not executed.`,
          503,
        );
      const delay = Math.max(
        1000 * 2 ** (attempt - 1),
        retryAfter(providerError.headers["retry-after"]),
      );
      onRetry?.(
        `${role === "agent" ? "Agent" : "Monitor"} rate limited; retrying attempt ${attempt + 1}/5 in ${Math.ceil(delay / 1000)}s`,
      );
      await sleep(Math.min(delay, 2_147_483_647), undefined, {
        signal: requestSignal,
      });
      requestSignal.throwIfAborted();
      onRetry?.(role === "agent" ? "Agent thinking" : "Monitor reviewing command");
    }
    if (!response) throw new Error("Inference service did not respond.");
    const data = await response.json();
    requestSignal.throwIfAborted();
    if (typeof data.id === "string")
      await db.query("UPDATE ctf.inference SET generation_id=$2 WHERE id=$1", [
        reservation.id,
        data.id,
      ]);
    if (data.error) {
      providerError = providerErrorDetails(response, data);
      throw new GameError(
        "Inference service returned an error. The command was not executed.",
        503,
      );
    }
    const usage = data.usage;
    if (
      !usage ||
      !Number.isFinite(usage.total_tokens) ||
      usage.total_tokens < 0 ||
      !Number.isFinite(usage.cost) ||
      usage.cost < 0
    )
      throw new GameError(
        "Inference usage could not be verified. Billing is pending; the command was not executed.",
        503,
      );
    await settleInference(reservation.id, {
      tokens: usage.total_tokens,
      cost: usage.cost,
      generationId: data.id,
    });
    settled = true;
    const choice = data.choices?.[0],
      source = choice?.message;
    if (!source) throw new Error("Inference service did not return a response.");
    if (role === "monitor" && choice.finish_reason === "length")
      throw new GameError(
        "The monitor response ended before a decision was complete. The command was not executed.",
        503,
      );
    const details = source.reasoning_details ?? [];
    const reasoning =
      source.reasoning ||
      source.reasoning_content ||
      details
        .filter((part: { type: string }) => part.type === "reasoning.text")
        .map((part: { text: string }) => part.text)
        .join("\n");
    const content: AssistantMessage["content"] = [];
    if (reasoning || details.length)
      content.push({
        type: "thinking",
        thinking: reasoning || "",
        thinkingSignature: JSON.stringify(details),
      });
    if (source.content) content.push({ type: "text", text: source.content });
    for (const call of source.tool_calls ?? []) {
      let args;
      try {
        args = JSON.parse(call.function.arguments);
      } catch {
        throw new Error("The agent proposed an invalid tool call.");
      }
      content.push({
        type: "toolCall",
        id: call.id,
        name: call.function.name === "game:sprite_exec" ? "sprite_exec" : call.function.name,
        arguments: args,
      });
    }
    console.info(
      JSON.stringify({
        event: "inference.completed",
        timestamp: new Date().toISOString(),
        ...context,
        status: response.status,
        durationMs: Date.now() - started,
        generationId: diagnosticText(data.id),
        tokens: usage.total_tokens,
        cost: usage.cost,
      }),
    );
    return {
      role: "assistant",
      content,
      api: model.api,
      provider: model.provider,
      model: model.id,
      responseId: data.id,
      timestamp: Date.now(),
      stopReason: source.tool_calls?.length
        ? "toolUse"
        : choice.finish_reason === "length"
          ? "length"
          : "stop",
      usage: {
        input: usage.prompt_tokens,
        output: usage.completion_tokens,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: usage.total_tokens,
        reasoning: usage.completion_tokens_details?.reasoning_tokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage.cost },
      },
    };
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "inference.failed",
        timestamp: new Date().toISOString(),
        ...context,
        status: response?.status,
        durationMs: Date.now() - started,
        providerError,
        errorName: error instanceof Error ? error.name : "UnknownError",
        error: diagnosticText(error instanceof Error ? error.message : error),
        usageVerified: settled,
      }),
    );
    throw error;
  } finally {
    if (!settled && knownUnbilled) await settleInference(reservation.id, { tokens: 0, cost: 0 });
  }
}

export function agentStream(
  game: GameRow,
  model: Model<"openai-completions">,
  onFailure: (error: unknown) => void,
  onRetry?: (message: string) => void,
) {
  return (_model: Model<Api>, context: TranscriptContext, options?: { signal?: AbortSignal }) => {
    const stream = createAssistantMessageEventStream();
    void infer(game, "agent", model, context.messages, options?.signal, onRetry)
      .then((message) =>
        stream.push({
          type: "done",
          reason: message.stopReason as "stop" | "length" | "toolUse",
          message,
        }),
      )
      .catch((error) => {
        onFailure(error);
        const message: AssistantMessage = {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: Date.now(),
          stopReason: "error",
          errorMessage:
            error instanceof GameError
              ? error.message
              : "The agent service could not finish this response. You can try again.",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
        stream.push({ type: "error", reason: "error", error: message });
      });
    return stream;
  };
}
