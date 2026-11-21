import { Value } from "typebox/value";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import {
  Agent,
  type AgentMessage,
  type AgentTool,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import { INVESTIGATOR_MODEL } from "./policy";
import {
  agentStream,
  getModel,
  providerTranscript,
  type TrustedInferenceOptions,
} from "./inference";
import { MONITOR_OUTPUT_TOKENS } from "./monitor-evidence";
import { notifyInvestigationObserver, type InvestigationObserver } from "./investigation-trace";
import type { RunMonitorReviewInput } from "./monitor-review";
import {
  BOUNDED_INVESTIGATOR_POLICY,
  MONITOR_CALL_LIMIT,
  MAX_CALL_LIMIT,
  MIN_CALL_LIMIT,
} from "./investigator-evaluation-policy";

export { MONITOR_CALL_LIMIT };
export { INVESTIGATOR_MODEL } from "./policy";
export const INVESTIGATOR_EFFORT = "high" as const;

const failureFacts = new WeakMap<
  object,
  { calls: number; forced: boolean; continuations: number }
>();

// The number of investigator requests a failed review made, or null when none could have been.
export function investigatorCallsOf(error: unknown): number | null {
  return typeof error === "object" && error !== null
    ? (failureFacts.get(error)?.calls ?? null)
    : null;
}

// Whether a failed review had received the final-request notice.
export function investigatorForcedOf(error: unknown): boolean {
  return typeof error === "object" && error !== null
    ? (failureFacts.get(error)?.forced ?? false)
    : false;
}

// How many of a failed review's responses were cut off at the output limit.
export function investigatorContinuationsOf(error: unknown): number {
  return typeof error === "object" && error !== null
    ? (failureFacts.get(error)?.continuations ?? 0)
    : 0;
}

function withCalls(error: unknown, calls: number, forced: boolean, continuations: number) {
  if (typeof error === "object" && error !== null)
    failureFacts.set(error, { calls, forced, continuations });
  return error;
}

const CONTINUE_MESSAGE =
  "Your last response reached the output limit and was cut off. Continue from where you stopped.";

export function budgetLine(limit: number) {
  return `This review has ${limit} model request${limit === 1 ? "" : "s"}. Retrieval calls spend them. Decide on the last one.`;
}

function finalRequestNotice(finishName: string) {
  return `This is the final request. Call ${finishName} now with the evidence already retrieved. Report a read only if that evidence establishes it.`;
}

export function createInvestigatorAgent(
  model: Model<"openai-completions">,
  tools: AgentTool[],
  streamFn: StreamFn,
  systemPrompt: string,
) {
  return new Agent({
    initialState: { systemPrompt, model, thinkingLevel: INVESTIGATOR_EFFORT, tools },
    streamFn,
  });
}

function abortedStream(model: Model<Api>) {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    model: model.id,
    provider: model.provider,
    timestamp: Date.now(),
    stopReason: "error",
    errorMessage: "The investigator review has ended.",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  stream.push({ type: "error", reason: "aborted", error: message });
  return stream;
}

export function guardInvestigatorStream(
  dispatch: ReturnType<typeof agentStream>,
  options: {
    signal: AbortSignal;
    isStopped: () => boolean;
    onLimit: () => void;
    onContextLimit?: (bytes: number, limit: number) => void;
    maxContextBytes?: number;
    admitCall: () => boolean;
  },
) {
  return (
    model: Model<Api>,
    context: Parameters<ReturnType<typeof agentStream>>[1],
    streamOptions?: { signal?: AbortSignal },
  ) => {
    if (options.signal.aborted || options.isStopped()) return abortedStream(model);
    const bytes = Buffer.byteLength(
      JSON.stringify(providerTranscript(context.messages, model.id)),
      "utf8",
    );
    if (options.maxContextBytes !== undefined && bytes > options.maxContextBytes) {
      options.onContextLimit?.(bytes, options.maxContextBytes);
      return abortedStream(model);
    }
    if (!options.admitCall()) {
      options.onLimit();
      return abortedStream(model);
    }
    return dispatch(model, context, streamOptions);
  };
}

type InvestigatorSetup = {
  tools: AgentTool[];
  finishTool: AgentTool;
  prompt: string;
  maxContextBytes: number;
  initialEvidenceCount: number;
  retrievalCalls: () => number;
  retrievedRefs: () => string[];
  dispose?: () => Promise<void>;
};

export async function runInvestigatorDriver<T>(
  input: RunMonitorReviewInput,
  config: {
    systemPrompt: string;
    finishName: string;
    observer?: InvestigationObserver;
    recoverToolSchemaErrors?: boolean;
    prepare: (context: {
      callLimit: number;
      model: Model<"openai-completions">;
      signal: AbortSignal;
      recordFailure: (error: unknown) => void;
      finish: (value: T) => void;
      onInvalid: (error: unknown, toolCallId: string) => void;
      requests: () => { calls: number; limit: number };
    }) => Promise<InvestigatorSetup> | InvestigatorSetup;
  },
): Promise<{
  decision: T;
  revision: number;
  calls: number;
  retrievalCalls: number;
  latencyMs: number;
  initialEvidenceCount: number;
  retrievedRefs: string[];
  forcedDecision: boolean;
  continuations: number;
}> {
  const limit = input.callLimit ?? MONITOR_CALL_LIMIT;
  if (!Number.isInteger(limit) || limit < MIN_CALL_LIMIT || limit > MAX_CALL_LIMIT)
    throw new Error(
      `Investigator call limit must be an integer from ${MIN_CALL_LIMIT} to ${MAX_CALL_LIMIT}.`,
    );
  const started = Date.now();
  const deadline = Math.min(
    input.deadlineAt ?? Number.POSITIVE_INFINITY,
    started + BOUNDED_INVESTIGATOR_POLICY.deadlineMs,
  );
  if (input.signal.aborted) throw new Error("Investigator review was cancelled.");
  const timeLeft = deadline - Date.now();
  if (timeLeft <= 0) throw new Error("Investigator review deadline expired.");
  const deadlineSignal = AbortSignal.timeout(timeLeft);
  const signal = AbortSignal.any([input.signal, deadlineSignal]);
  const catalogModel = await getModel(INVESTIGATOR_MODEL, signal);
  const model = {
    ...catalogModel,
    cost: {
      input: BOUNDED_INVESTIGATOR_POLICY.inputUsdPerMillion,
      output: BOUNDED_INVESTIGATOR_POLICY.outputUsdPerMillion,
      cacheRead: BOUNDED_INVESTIGATOR_POLICY.inputUsdPerMillion,
      cacheWrite: BOUNDED_INVESTIGATOR_POLICY.inputUsdPerMillion,
    },
  };
  if (signal.aborted)
    throw new Error(
      input.signal.aborted
        ? "Investigator review was cancelled."
        : "Investigator review deadline expired.",
    );
  let decision: T | undefined;
  let failure: unknown;
  let lastInvalidDecision: string | undefined;
  const invalidFinishCalls = new Set<string>();
  const toolArguments = new Map<string, unknown>();
  let investigator: Agent | undefined;
  let setup: InvestigatorSetup | undefined;
  let calls = 0;
  let forcedDecision = false;
  let continuations = 0;
  // Tool calls in a cut-off response. The agent library reports each as a tool error unexecuted.
  const cutOffCalls = new Set<string>();
  const recordFailure = (error: unknown) => {
    failure ??= error;
    investigator?.abort();
  };
  const finish = (value: T) => {
    if (decision || failure) throw new Error("Conflicting investigator decision.");
    decision = value;
  };
  const onInvalid = (error: unknown, toolCallId: string) => {
    invalidFinishCalls.add(toolCallId);
    lastInvalidDecision =
      error instanceof Error ? error.message : `Invalid ${config.finishName} arguments.`;
  };
  const result = () => {
    if (!decision || !setup)
      throw new Error(`Investigator ended without a valid ${config.finishName} decision.`);
    return {
      decision,
      revision: input.snapshot.revision,
      calls,
      retrievalCalls: setup.retrievalCalls(),
      latencyMs: Date.now() - started,
      initialEvidenceCount: setup.initialEvidenceCount,
      retrievedRefs: setup.retrievedRefs(),
      forcedDecision,
      continuations,
    };
  };
  const disposeSignal = () => investigator?.abort();
  signal.addEventListener("abort", disposeSignal, { once: true });
  try {
    setup = await config.prepare({
      callLimit: limit,
      model,
      signal,
      recordFailure,
      finish,
      onInvalid,
      requests: () => ({ calls, limit }),
    });
    if (failure) throw failure;
    const dispatch = agentStream(input.game, model, recordFailure, undefined, undefined, {
      role: "monitor",
      sessionId: input.currentSessionId,
      reviewId: input.reviewId,
      effort: INVESTIGATOR_EFFORT,
      maxOutputTokens: MONITOR_OUTPUT_TOKENS,
      stage: "investigator",
      jobClaim: input.jobClaim,
      streamIdleMs: input.streamIdleMs,
      stopOnReservationOverrun: true,
      providerEndpoint: BOUNDED_INVESTIGATOR_POLICY.providerEndpoint,
    } satisfies TrustedInferenceOptions);
    const streamFn = guardInvestigatorStream(dispatch, {
      signal,
      isStopped: () => Boolean(failure || decision),
      onLimit: () =>
        recordFailure(
          new Error(
            lastInvalidDecision
              ? `Investigator call limit reached after ${lastInvalidDecision}`
              : "Investigator call limit reached.",
          ),
        ),
      maxContextBytes: setup.maxContextBytes,
      onContextLimit: (bytes, limit) =>
        recordFailure(new Error(`Investigator context limit reached: ${bytes} bytes > ${limit}.`)),
      admitCall: () => {
        if (calls >= limit) return false;
        calls += 1;
        return true;
      },
    });
    investigator = createInvestigatorAgent(model, setup.tools, streamFn, config.systemPrompt);
    // A response that ends at the output limit is continued, and the loop does not end on it.
    investigator.finishTurn = ({ message }) =>
      message.role === "assistant" &&
      message.stopReason === "length" &&
      !decision &&
      !failure &&
      calls < limit
        ? { action: "continue" }
        : undefined;
    // The hook runs before every request after the first. It tells the model to continue after a
    // cut-off response. When the next request is the last the limit allows, it then adds the
    // notice and offers only the finish tool.
    investigator.prepareNextTurnWithContext = ({ context, message }) => {
      // A valid finish does not end the loop by itself, so a settled review is left alone.
      if (decision || failure) return undefined;
      const cutOff = message.role === "assistant" && message.stopReason === "length";
      const last = calls === limit - 1;
      if (!cutOff && !last) return undefined;
      const messages: AgentMessage[] = [];
      if (cutOff) messages.push({ role: "user", content: CONTINUE_MESSAGE, timestamp: Date.now() });
      if (last) {
        forcedDecision = true;
        messages.push({
          role: "user",
          content: finalRequestNotice(config.finishName),
          timestamp: Date.now(),
        });
      }
      return last
        ? { context: { ...context, tools: [setup!.finishTool] }, messages }
        : { messages };
    };
    investigator.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant")
        for (const part of event.message.content)
          if (part.type === "toolCall") toolArguments.set(part.id, part.arguments);
      if (
        event.type === "message_end" &&
        event.message.role === "assistant" &&
        event.message.stopReason === "length"
      ) {
        continuations += 1;
        for (const part of event.message.content)
          if (part.type === "toolCall") cutOffCalls.add(part.id);
        if (calls >= limit)
          recordFailure(new Error("Investigator output reached its token limit."));
      }
      if (
        event.type === "tool_execution_end" &&
        config.observer &&
        setup?.tools.some((tool) => tool.name === event.toolName)
      )
        notifyInvestigationObserver(config.observer, "onToolResult", {
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          arguments: toolArguments.get(event.toolCallId),
          isError: event.isError,
          content: event.result.content,
        });
      // The id is forgotten once its tool result arrives, so a reused id is not skipped later.
      const cutOff = event.type === "tool_execution_end" && cutOffCalls.delete(event.toolCallId);
      if (event.type === "tool_execution_end" && event.toolName === config.finishName) {
        const rawArgs = toolArguments.get(event.toolCallId);
        toolArguments.delete(event.toolCallId);
        if (event.isError && !failure && !cutOff) {
          const output = event.result as { content?: { type: string; text?: string }[] };
          const schemaRejected =
            rawArgs !== undefined &&
            !Value.Check(setup!.finishTool.parameters, rawArgs) &&
            !!output.content?.some(
              (part) =>
                part.type === "text" &&
                part.text?.startsWith(`Validation failed for tool "${config.finishName}":`),
            );
          if (invalidFinishCalls.delete(event.toolCallId) || schemaRejected)
            lastInvalidDecision ??= `Invalid ${config.finishName} arguments.`;
          else recordFailure(new Error(`Investigator ${config.finishName} tool failed.`));
        }
        if (decision || failure) investigator?.abort();
      } else if (event.type === "tool_execution_end") {
        const rawArgs = toolArguments.get(event.toolCallId);
        toolArguments.delete(event.toolCallId);
        const tool = setup?.tools.find((item) => item.name === event.toolName);
        const output = event.result as { content?: { type: string; text?: string }[] };
        const schemaRejected =
          config.recoverToolSchemaErrors &&
          event.isError &&
          rawArgs !== undefined &&
          tool !== undefined &&
          !Value.Check(tool.parameters, rawArgs) &&
          !!output.content?.some(
            (part) =>
              part.type === "text" &&
              part.text?.startsWith(`Validation failed for tool "${event.toolName}":`),
          );
        if (event.isError && !decision && !schemaRejected && !cutOff)
          recordFailure(new Error(`Investigator tool failed: ${event.toolName}.`));
      }
      if (event.type === "agent_end" && !decision && !failure)
        failure = new Error(
          lastInvalidDecision
            ? `Investigator ended after ${lastInvalidDecision}`
            : `Investigator ended without a valid ${config.finishName} decision.`,
        );
    });
    if (signal.aborted)
      throw new Error(
        input.signal.aborted
          ? "Investigator review was cancelled."
          : "Investigator review deadline expired.",
      );
    if (failure) throw failure;
    await investigator.prompt(setup.prompt);
    if (failure) throw failure;
    return result();
  } catch (error) {
    if (decision && !failure) return result();
    if (failure) throw withCalls(failure, calls, forcedDecision, continuations);
    if (input.signal.aborted)
      throw withCalls(
        new Error("Investigator review was cancelled.", { cause: error }),
        calls,
        forcedDecision,
        continuations,
      );
    if (deadlineSignal.aborted)
      throw withCalls(
        new Error("Investigator review deadline expired.", { cause: error }),
        calls,
        forcedDecision,
        continuations,
      );
    throw withCalls(error, calls, forcedDecision, continuations);
  } finally {
    signal.removeEventListener("abort", disposeSignal);
    await setup?.dispose?.();
  }
}
