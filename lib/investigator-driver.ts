import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  type Api,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { INVESTIGATOR_MODEL } from "./policy";
import {
  agentStream,
  getModel,
  providerTranscript,
  type TrustedInferenceOptions,
} from "./inference";
import { INVESTIGATOR_SYSTEM_PROMPT, MONITOR_OUTPUT_TOKENS } from "./monitor-evidence";
import { notifyInvestigationObserver, type InvestigationObserver } from "./investigation-trace";
import type { RunMonitorReviewInput } from "./monitor-review";

export const MONITOR_CALL_LIMIT = 8;
export const MONITOR_DEADLINE_MS = 60_000;
export { INVESTIGATOR_MODEL } from "./policy";
export const INVESTIGATOR_EFFORT = "high" as const;

export async function createIsolatedInvestigatorSession(
  model: Model<"openai-completions">,
  customTools: ToolDefinition[],
  systemPrompt = INVESTIGATOR_SYSTEM_PROMPT,
) {
  const directory = await mkdtemp(join(tmpdir(), "tripwire-monitor-"));
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const settings = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
      cacheWarming: "off",
    });
    const loader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: directory,
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPromptOverride: () => systemPrompt,
    });
    await loader.reload();
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    const sessionManager = SessionManager.inMemory(directory);
    ({ session } = await createAgentSession({
      cwd: directory,
      agentDir: directory,
      modelRuntime,
      model,
      thinkingLevel: INVESTIGATOR_EFFORT,
      tools: customTools.map((tool) => tool.name),
      noTools: "all",
      customTools,
      sessionManager,
      settingsManager: settings,
      resourceLoader: loader,
    }));
    return {
      session,
      dispose: async () => {
        try {
          session?.dispose();
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    session?.dispose();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
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
  tools: ToolDefinition[];
  finishTool: ToolDefinition;
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
      model: Model<"openai-completions">;
      signal: AbortSignal;
      recordFailure: (error: unknown) => void;
      finish: (value: T) => void;
      onInvalid: (error: unknown, toolCallId: string) => void;
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
}> {
  const started = Date.now();
  const deadline = Math.min(
    input.deadlineAt ?? Number.POSITIVE_INFINITY,
    started + MONITOR_DEADLINE_MS,
  );
  if (input.signal.aborted) throw new Error("Investigator review was cancelled.");
  const timeLeft = deadline - Date.now();
  if (timeLeft <= 0) throw new Error("Investigator review deadline expired.");
  const deadlineSignal = AbortSignal.timeout(timeLeft);
  const signal = AbortSignal.any([input.signal, deadlineSignal]);
  const model = await getModel(INVESTIGATOR_MODEL, signal);
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
  let investigator: Awaited<ReturnType<typeof createIsolatedInvestigatorSession>> | undefined;
  let setup: InvestigatorSetup | undefined;
  let calls = 0;
  const recordFailure = (error: unknown) => {
    failure ??= error;
    investigator?.session.agent.abort();
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
    };
  };
  const disposeSignal = () => investigator?.session.agent.abort();
  signal.addEventListener("abort", disposeSignal, { once: true });
  try {
    setup = await config.prepare({ model, signal, recordFailure, finish, onInvalid });
    if (failure) throw failure;
    investigator = await createIsolatedInvestigatorSession(model, setup.tools, config.systemPrompt);
    const dispatch = agentStream(input.game, model, recordFailure, undefined, undefined, {
      role: "monitor",
      sessionId: input.currentSessionId,
      reviewId: input.reviewId,
      effort: INVESTIGATOR_EFFORT,
      maxOutputTokens: MONITOR_OUTPUT_TOKENS,
      stage: "investigator",
      finalizationToken: input.finalizationToken,
      pendingReviewId: input.pendingReviewId,
      jobClaim: input.jobClaim,
    } satisfies TrustedInferenceOptions);
    investigator.session.agent.streamFunction = guardInvestigatorStream(dispatch, {
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
        if (calls >= MONITOR_CALL_LIMIT) return false;
        calls += 1;
        return true;
      },
    });
    investigator.session.agent.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant")
        for (const part of event.message.content)
          if (part.type === "toolCall") toolArguments.set(part.id, part.arguments);
      if (
        event.type === "message_end" &&
        event.message.role === "assistant" &&
        event.message.stopReason === "length"
      )
        recordFailure(new Error("Investigator output reached its token limit."));
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
      if (event.type === "tool_execution_end" && event.toolName === config.finishName) {
        const rawArgs = toolArguments.get(event.toolCallId);
        toolArguments.delete(event.toolCallId);
        if (event.isError && !failure) {
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
        if (decision || failure) investigator?.session.agent.abort();
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
        if (event.isError && !decision && !schemaRejected)
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
    await investigator.session.agent.prompt(setup.prompt);
    if (failure) throw failure;
    return result();
  } catch (error) {
    if (failure) throw failure;
    if (decision) return result();
    if (input.signal.aborted)
      throw new Error("Investigator review was cancelled.", { cause: error });
    if (deadlineSignal.aborted)
      throw new Error("Investigator review deadline expired.", { cause: error });
    throw error;
  } finally {
    signal.removeEventListener("abort", disposeSignal);
    try {
      await investigator?.dispose();
    } finally {
      await setup?.dispose?.();
    }
  }
}
