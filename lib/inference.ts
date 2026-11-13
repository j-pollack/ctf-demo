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
import { assertLease, reserveInference, settleInference, transaction, type GameRow } from "./games";
import { db } from "./db";
import { GameError, inputCeiling, MODELS, PLAYER_AGENT_EFFORT } from "./policy";
import type { AgentEffort } from "./types";
import { assertMonitorAuthorization } from "./run-lifecycle";
import { assertMonitorJobClaim, type MonitorJobClaim } from "./monitor-jobs";

export type TrustedInferenceOptions = {
  role?: "agent" | "monitor";
  sessionId?: string;
  reviewId?: string;
  effort?: AgentEffort;
  maxOutputTokens?: number;
  finalizationToken?: string;
  pendingReviewId?: string;
  jobClaim?: MonitorJobClaim;
  stage?: string;
  singleAttempt?: boolean;
  stopOnReservationOverrun?: boolean;
};

type CatalogModel = {
  id: string;
  context_length: number;
  pricing: { prompt: string; completion: string; request?: string };
  supported_parameters: string[];
};
let catalog: { expires: number; models: CatalogModel[] } | undefined;
export async function getModel(
  id: string,
  signal?: AbortSignal,
): Promise<Model<"openai-completions">> {
  signal?.throwIfAborted();
  if (!MODELS.some((model) => model === id)) throw new GameError("Unsupported model.");
  if (!catalog || catalog.expires < Date.now()) {
    const response = await fetch("https://openrouter.ai/api/v1/models", {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
        : AbortSignal.timeout(15000),
      cache: "no-store",
    });
    if (!response.ok) throw new Error("Model catalog is unavailable.");
    const data = await response.json();
    catalog = { expires: Date.now() + 300000, models: data.data };
  }
  signal?.throwIfAborted();
  const entry = catalog.models.find((model) => model.id === id);
  if (!entry || Number(entry.pricing.request ?? 0) !== 0)
    throw new GameError("The selected model is unavailable for this game.", 503);
  const reasoning = entry.supported_parameters.includes("reasoning");
  if (!reasoning)
    throw new GameError("The configured model does not support readable reasoning.", 503);
  if (!entry.supported_parameters.includes("tools"))
    throw new GameError(
      "The selected agent model does not support the required request format.",
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

// A piece of one tool call: `name` arrives with its first piece, `arguments` text in pieces.
export type CallFragment = { index: number; name?: string; arguments?: string };
export type AgentDelta = { reasoning?: string; text?: string; calls?: CallFragment[] };
// Reasoning counts toward output, so agents need room to think and then answer. Admission still
// lowers this to what the run's remaining budget can pay for.
export const AGENT_OUTPUT_TOKENS = 16_384;
// A streamed call that sends nothing for this long, not even a keep-alive, is stuck.
export const STREAM_IDLE_MS = 45_000;
// Time kept back from the lease so a stopped call can still record its error.
const LEASE_MARGIN_MS = 5_000;
type StreamedToolCall = { id: string; type: string; function: { name: string; arguments: string } };
type Fragment = Record<string, unknown> & { index?: number };
// Fragments of one reasoning detail share an index; their text-like fields concatenate.
function mergeFragment(parts: Fragment[], part: Fragment) {
  const existing = parts.find((item) => (item.index ?? 0) === (part.index ?? 0));
  if (!existing) return void parts.push({ ...part });
  for (const [key, value] of Object.entries(part))
    existing[key] =
      ["text", "summary", "data"].includes(key) && typeof value === "string"
        ? String(existing[key] ?? "") + value
        : value;
}
// Rebuilds a streamed chat completion into the non-streaming response shape, so billing and
// transcript handling stay identical. The generation id is reported as soon as it arrives, so a
// stream cut off midway can still be reconciled.
export async function collectStream(
  body: ReadableStream<Uint8Array>,
  onDelta: (delta: AgentDelta) => void,
  onId: (id: string) => Promise<unknown>,
  idleMs = STREAM_IDLE_MS,
) {
  const message = {
    content: "",
    reasoning: "",
    reasoning_details: [] as Fragment[],
    tool_calls: [] as StreamedToolCall[],
  };
  const data: {
    id?: string;
    error?: unknown;
    usage?: Record<string, number> & { completion_tokens_details?: { reasoning_tokens?: number } };
    choices: { message: typeof message; finish_reason: string | null }[];
  } = { choices: [{ message, finish_reason: null }] };
  const decoder = new TextDecoder();
  let buffer = "";
  const line = async (text: string) => {
    // SSE comments (": OPENROUTER PROCESSING") and the [DONE] marker carry no data.
    if (!text.startsWith("data:")) return;
    const value = text.slice(5).trim();
    if (value === "[DONE]") return;
    const chunk = JSON.parse(value);
    if (typeof chunk.id === "string" && !data.id) {
      data.id = chunk.id;
      await onId(chunk.id);
    }
    if (chunk.error) data.error = chunk.error;
    if (chunk.usage) data.usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) data.choices[0].finish_reason = choice.finish_reason;
    const delta = choice.delta ?? {};
    const details: Fragment[] = delta.reasoning_details ?? [];
    details.forEach((part) => mergeFragment(message.reasoning_details, part));
    let reasoning = delta.reasoning ?? delta.reasoning_content ?? "";
    message.reasoning += reasoning;
    if (!reasoning)
      reasoning = details
        .filter((part) => part.type === "reasoning.text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("");
    const content = delta.content ?? "";
    message.content += content;
    const calls: CallFragment[] = [];
    for (const call of delta.tool_calls ?? []) {
      const index = call.index ?? 0;
      const name = call.function?.name ?? "",
        args = call.function?.arguments ?? "";
      if (name || args)
        calls.push({ index, ...(name && { name }), ...(args && { arguments: args }) });
      const target = (message.tool_calls[index] ??= {
        id: "",
        type: "function",
        function: { name: "", arguments: "" },
      });
      if (call.id) target.id = call.id;
      target.function.name += call.function?.name ?? "";
      target.function.arguments += call.function?.arguments ?? "";
    }
    if (reasoning || content || calls.length)
      onDelta({
        ...(reasoning && { reasoning }),
        ...(content && { text: content }),
        ...(calls.length && { calls }),
      });
  };
  const reader = body.getReader();
  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stalled = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new GameError("The agent stopped responding. Please try again.", 504)),
        idleMs,
      );
    });
    const next = await Promise.race([reader.read(), stalled])
      .catch(async (error) => {
        await reader.cancel().catch(() => {});
        throw error;
      })
      .finally(() => clearTimeout(timer));
    if (next.done) break;
    const bytes = next.value;
    buffer += decoder.decode(bytes, { stream: true });
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const text = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      await line(text);
    }
  }
  await line((buffer + decoder.decode()).trim());
  return data;
}

// Reasoning effort is a provider hint, not a hard token partition. Reasoning can consume
// the entire output allowance, leaving a length-limited response without a tool call.
export function reasoningParam(
  model: Pick<Model<"openai-completions">, "reasoning">,
  effort: AgentEffort = PLAYER_AGENT_EFFORT,
) {
  return model.reasoning ? { effort, exclude: false } : undefined;
}

// Agent calls stream so the player can watch reasoning arrive; the assembled response is still
// the one authoritative record for accounting and the transcript.
export async function infer(
  game: GameRow,
  model: Model<"openai-completions">,
  messages: Message[],
  signal?: AbortSignal,
  onRetry?: (message: string) => void,
  onDelta?: (delta: AgentDelta) => void,
  trusted: TrustedInferenceOptions = {},
): Promise<AssistantMessage> {
  signal?.throwIfAborted();
  if (!process.env.OPENROUTER_API_KEY) throw new Error("Inference is not configured.");
  const role = trusted.role ?? "agent";
  const sessionId = trusted.sessionId ?? game.session_id ?? game.id;
  const effort = trusted.effort ?? game.agent_effort;
  const outputCeiling =
    role === "monitor" ? (trusted.maxOutputTokens ?? 4096) : AGENT_OUTPUT_TOKENS;
  const reasoning = reasoningParam(model, effort);
  const payload = {
    model: model.id,
    ...providerTranscript(messages, model.id),
    session_id: `${sessionId}:${role}${trusted.reviewId ? `:${trusted.reviewId}` : ""}`,
    ...(reasoning ? { reasoning } : {}),
    provider: { require_parameters: true, ...(role === "agent" ? { sort: "price" } : {}) },
    ...(onDelta ? { stream: true } : {}),
  };
  const ceiling = inputCeiling(payload);
  if (ceiling + 4096 > model.contextWindow)
    throw new GameError("This conversation is too long for the configured model.", 400);
  const reservation = await reserveInference(
    game.id,
    game.lease,
    role,
    model.id,
    ceiling,
    Math.min(outputCeiling, model.contextWindow - ceiling),
    model.cost.input / 1e6,
    model.cost.output / 1e6,
    {
      sessionId,
      reviewId: trusted.reviewId,
      finalizationToken: trusted.finalizationToken,
      pendingReviewId: trusted.pendingReviewId,
      executionGeneration: Number(game.execution_generation ?? 0),
      jobClaim: trusted.jobClaim,
    },
  );
  const started = Date.now(),
    context = {
      gameId: game.id,
      requestId: reservation.id,
      role,
      model: model.id,
      stage: trusted.stage,
    };
  let settled = false;
  // A reservation is still refundable until the provider transport is entered. Any failure in
  // local authorization or cancellation before that point must release the hold.
  let knownUnbilled = true;
  let response: Response | undefined,
    providerError: ReturnType<typeof providerErrorDetails> | undefined;
  // A streamed agent call may use whatever the response's lease has left while it keeps making
  // progress; non-streaming calls keep a fixed bound.
  const deadline = AbortSignal.timeout(
    onDelta
      ? Math.max(0, new Date(game.lease_until ?? 0).getTime() - Date.now() - LEASE_MARGIN_MS)
      : 90000,
  );
  const requestSignal = AbortSignal.any([signal ?? new AbortController().signal, deadline]);
  const assertDispatchPermit = async () => {
    requestSignal.throwIfAborted();
    if (role === "agent") {
      await assertLease(game);
      requestSignal.throwIfAborted();
      return;
    }
    if (!trusted.jobClaim && (!game.lease || !trusted.reviewId))
      throw new GameError("Monitor review authorization is required.", 409);
    await transaction(async (client) => {
      const { rows } = await client.query<{ execution_generation: string }>(
        "SELECT execution_generation FROM ctf.games WHERE id=$1 FOR UPDATE",
        [game.id],
      );
      if (
        !rows[0] ||
        (!trusted.jobClaim &&
          Number(rows[0].execution_generation) !== Number(game.execution_generation ?? 0))
      )
        throw new GameError("This response has stopped.", 409);
      if (trusted.jobClaim) await assertMonitorJobClaim(client, trusted.jobClaim);
      else
        await assertMonitorAuthorization(client, game.id, sessionId, game.lease!, {
          reviewId: trusted.reviewId,
          finalizationToken: trusted.finalizationToken,
          pendingReviewId: trusted.pendingReviewId,
        });
    });
    requestSignal.throwIfAborted();
  };
  try {
    const attempts = trusted.singleAttempt ? 1 : 5;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      await assertDispatchPermit();
      response = undefined;
      providerError = undefined;
      knownUnbilled = false;
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
      if (response.status !== 429 || attempt === attempts)
        throw new GameError(
          `Inference service returned ${response.status}. The command was not executed.`,
          503,
        );
      const delay = Math.max(
        1000 * 2 ** (attempt - 1),
        retryAfter(providerError.headers["retry-after"]),
      );
      const caller = role === "monitor" ? "Investigator" : "Agent";
      onRetry?.(
        `${caller} rate limited; retrying attempt ${attempt + 1}/5 in ${Math.ceil(delay / 1000)}s`,
      );
      await sleep(Math.min(delay, 2_147_483_647), undefined, {
        signal: requestSignal,
      });
      requestSignal.throwIfAborted();
      onRetry?.("Agent thinking");
    }
    if (!response) throw new Error("Inference service did not respond.");
    const data =
      onDelta && response.body
        ? await collectStream(response.body, onDelta, (id) =>
            db.query("UPDATE ctf.inference SET generation_id=$2 WHERE id=$1", [reservation.id, id]),
          )
        : await response.json();
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
    if (trusted.stopOnReservationOverrun && Math.ceil(usage.cost * 1e6) > reservation.cost)
      throw new Error("Inference usage exceeded its reserved allowance.");
    const choice = data.choices?.[0],
      source = choice?.message;
    if (!source) throw new Error("Inference service did not return a response.");
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
      stopReason:
        choice.finish_reason === "length"
          ? "length"
          : source.tool_calls?.length
            ? "toolUse"
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
    if (onDelta && (deadline.aborted || (error instanceof Error && error.name === "TimeoutError")))
      throw new GameError(
        "The agent ran out of time for this response. Any charge settles automatically; try again or ask for a shorter answer.",
        504,
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
  onDelta?: (delta: AgentDelta) => void,
  trustedOptions: TrustedInferenceOptions = {},
) {
  return (_model: Model<Api>, context: TranscriptContext, options?: { signal?: AbortSignal }) => {
    const stream = createAssistantMessageEventStream();
    void infer(game, model, context.messages, options?.signal, onRetry, onDelta, trustedOptions)
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
