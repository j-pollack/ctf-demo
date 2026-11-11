import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, Type, type Message } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { beginAsyncSubmission } from "./async-finalization";
import { db } from "./db";
import {
  assertLease,
  cleanup,
  finishSessionRun,
  gameBilling,
  publicGame,
  record,
  type GameRow,
} from "./games";
import { agentStream, diagnosticText, getModel, reasoningOf, textOf } from "./inference";
import { completeAsyncCommand, dispatchAsyncCommand } from "./monitor-commands";
import { GameError, agentPrompt } from "./policy";
import { releaseSessionLease, persistReviewedSessionMessages } from "./sessions";
import { checkpointEnvironment, executeCommand } from "./sprites";
import { repairMessages } from "./transcript-repair";
import type { GameEvent } from "./types";

const HEARTBEAT_MS = 1000;
const HEARTBEAT_TIMEOUT_MS = 3000;

export async function runAsyncGame(
  inputGame: GameRow,
  prompt: string,
  signal: AbortSignal,
  send: (type: string, data: unknown) => void,
  options: { deadlineSignal?: AbortSignal } = {},
) {
  const game = { ...inputGame };
  const sessionId = game.session_id ?? game.id;
  const lease = game.lease;
  if (!lease) throw new GameError("This response has stopped.", 409);
  const generation = Number(game.execution_generation ?? 0);
  const stop = new AbortController();
  const activeCommands = new Map<string, string>();
  let directory: string | undefined;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let failure: unknown;
  let checkpoint: string | undefined;
  let phase = "";
  let heartbeatBusy = false;

  const abort = (error?: unknown) => {
    if (error) failure ??= error;
    stop.abort();
    session?.agent.abort();
  };
  const onSignal = () => abort();
  signal.addEventListener("abort", onSignal, { once: true });

  const checkHeartbeat = async () => {
    if (heartbeatBusy || stop.signal.aborted) return;
    heartbeatBusy = true;
    try {
      const query = db.query<{
        status: string;
        execution_generation: string;
        lease: string | null;
        lease_until: Date | null;
      }>(
        `SELECT g.status,g.execution_generation,s.lease,s.lease_until
         FROM ctf.games g JOIN ctf.agent_sessions s ON s.game_id=g.id AND s.id=$2
         WHERE g.id=$1`,
        [game.id, sessionId],
      );
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const { rows } = await Promise.race([
        query,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Run heartbeat timed out.")),
            HEARTBEAT_TIMEOUT_MS,
          );
        }),
      ]).finally(() => clearTimeout(timeout));
      const state = rows[0];
      if (
        state?.status !== "active" ||
        Number(state.execution_generation) !== generation ||
        state.lease !== lease ||
        !state.lease_until ||
        state.lease_until <= new Date()
      )
        abort(new GameError("This response has stopped.", 409));
    } catch (error) {
      abort(error);
    } finally {
      heartbeatBusy = false;
    }
  };
  const heartbeat = setInterval(() => void checkHeartbeat(), HEARTBEAT_MS);

  const emitBilling = async () => {
    try {
      send("billing", await gameBilling(game.id));
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "billing.read.failed",
          gameId: game.id,
          error: diagnosticText(error instanceof Error ? error.message : error),
        }),
      );
    }
  };
  const emit = async (event: Omit<GameEvent, "id">) => {
    const saved = await record(game.id, event, lease, sessionId, generation);
    send("event", saved);
    await emitBilling();
  };

  try {
    const model = await getModel(game.agent_model);
    const systemPrompt = agentPrompt(game.system_prompt);
    const settings = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
      cacheWarming: "off",
    });
    directory = await mkdtemp(join(tmpdir(), "tripwire-"));
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
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    const manager = SessionManager.inMemory(directory);
    repairMessages(game.messages, systemPrompt).forEach((message) =>
      manager.appendMessage(message),
    );
    const commandTool = defineTool({
      name: "sprite_exec",
      label: "Game command",
      description: "Run a shell command in this game's isolated Linux environment.",
      parameters: Type.Object(
        { command: Type.String({ minLength: 1, maxLength: 8192 }) },
        { additionalProperties: false },
      ),
      executionMode: "sequential",
      execute: async (id, { command }, toolSignal) => {
        stop.signal.throwIfAborted();
        const dispatch = await dispatchAsyncCommand({
          gameId: game.id,
          sessionId,
          lease,
          toolCallId: id,
          command,
          generation,
        });
        activeCommands.set(id, dispatch.id);
        send("stage", "Running command");
        const output = await executeCommand(
          game.sprite_name,
          command,
          AbortSignal.any([stop.signal, toolSignal ?? new AbortController().signal]),
        );
        return { content: [{ type: "text" as const, text: output }], details: {} };
      },
    });
    const submitTool = defineTool({
      name: "submit",
      label: "Submit",
      description: "Submit the contents of /tmp/flag.txt. Passing any value ends the run.",
      parameters: Type.Object(
        { value: Type.String({ maxLength: 8192 }) },
        { additionalProperties: false },
      ),
      executionMode: "sequential",
      execute: async (_id, { value }) => {
        try {
          await beginAsyncSubmission({ gameId: game.id, sessionId, lease, value });
          game.status = "finalizing";
          send("state", { status: "finalizing", sessionId });
          abort();
          return { content: [{ type: "text" as const, text: "Submitted." }], details: {} };
        } catch (error) {
          abort(error);
          return { content: [{ type: "text" as const, text: "Not submitted." }], details: {} };
        }
      },
    });
    ({ session } = await createAgentSession({
      cwd: directory,
      agentDir: directory,
      modelRuntime: runtime,
      model,
      thinkingLevel: game.agent_effort,
      tools: ["sprite_exec", "submit"],
      noTools: "builtin",
      customTools: [commandTool, submitTool],
      sessionManager: manager,
      settingsManager: settings,
      resourceLoader: loader,
    }));
    if (session.getActiveToolNames().sort().join(",") !== "sprite_exec,submit")
      throw new Error("Unexpected tool configuration.");
    session.agent.streamFunction = agentStream(
      game,
      model,
      (error) => {
        if (game.status === "active") failure ??= error;
      },
      (stage) => send("stage", stage),
      (delta) => {
        const next = delta.calls
          ? "Tool called"
          : delta.text
            ? "Agent responding"
            : "Agent thinking";
        if (next !== phase) send("stage", (phase = next));
        send("delta", delta);
      },
      { role: "agent", sessionId },
    );
    session.agent.toolExecution = "sequential";
    session.agent.beforeToolCall = async ({ toolCall }) => {
      if (stop.signal.aborted || game.status !== "active")
        return { block: true, reason: "The run is over.", terminate: true };
      if (toolCall.name === "submit")
        return Value.Check(submitTool.parameters, toolCall.arguments)
          ? undefined
          : { block: true, reason: "Invalid submit arguments" };
      if (
        toolCall.name !== "sprite_exec" ||
        !Value.Check(commandTool.parameters, toolCall.arguments)
      )
        return { block: true, reason: "Invalid command arguments" };
      try {
        await assertLease(game);
        return undefined;
      } catch (error) {
        abort(error);
        return { block: true, reason: "This response has stopped.", terminate: true };
      }
    };
    session.agent.subscribe(async (event) => {
      if (event.type === "turn_start") send("stage", (phase = "Agent thinking"));
      if (event.type !== "message_end") return;
      const message = event.message as Message;
      if (
        failure &&
        !(
          message.role === "toolResult" &&
          message.toolName === "sprite_exec" &&
          activeCommands.has(message.toolCallId)
        )
      )
        return;
      if (
        message.role === "system" ||
        (message.role === "toolResult" && message.toolName === "submit")
      )
        return;
      try {
        const messages = session!.messages as Message[];
        if (message.role === "toolResult") {
          const dispatchId = activeCommands.get(message.toolCallId);
          if (dispatchId) {
            const output = textOf(message);
            const completed = await completeAsyncCommand({
              dispatchId,
              gameId: game.id,
              sessionId,
              messages,
              outcome: message.isError ? "unknown" : "completed",
              output,
            });
            activeCommands.delete(message.toolCallId);
            send("event", completed.event);
            await emitBilling();
            return;
          }
        }
        if (game.status !== "active") return;
        const turnsDelta =
          message.role === "assistant" &&
          message.stopReason !== "error" &&
          message.stopReason !== "aborted"
            ? 1
            : 0;
        await persistReviewedSessionMessages(
          game.id,
          sessionId,
          lease,
          messages,
          turnsDelta,
          generation,
        );
        if (turnsDelta) game.turns++;
        if (message.role === "user")
          await emit({ kind: "user", text: textOf(message), checkpoint });
        if (message.role === "assistant" && turnsDelta) {
          const commands = message.content.flatMap((part) =>
            part.type === "toolCall" && part.name === "sprite_exec"
              ? [String(part.arguments.command ?? "")]
              : [],
          );
          await emit({
            kind: "agent",
            text: textOf(message),
            reasoning: reasoningOf(message),
            command: commands.join("\n") || undefined,
            ...(commands.length && { commands }),
            turn: game.turns,
            model: message.model,
          });
        }
        if (message.role === "toolResult")
          await emit({ kind: "tool", text: textOf(message), turn: game.turns });
      } catch (error) {
        abort(error);
      }
    });
    if (signal.aborted) throw new Error("Response stopped.");
    await assertLease(game);
    const { rows: count } = await db.query<{ total: number }>(
      "SELECT count(*)::int AS total FROM ctf.agent_sessions WHERE game_id=$1",
      [game.id],
    );
    if ((count[0]?.total ?? 0) === 1) checkpoint = await checkpointEnvironment(game.sprite_name);
    await session.agent.prompt(prompt);
    if (failure && game.status === "active") throw failure;
    if (signal.aborted && game.status === "active") {
      await emit({
        kind: "error",
        text: "Response stopped. Your run is still open.",
        resumable: true,
        ...(options.deadlineSignal?.aborted && { autoContinue: true }),
      });
    }
  } catch (error) {
    if (game.status !== "finalizing" && game.status !== "caught" && game.status !== "ended") {
      const responseError = failure ?? error;
      console.error(
        JSON.stringify({
          event: "game.response.failed",
          gameId: game.id,
          error: diagnosticText(
            responseError instanceof Error ? responseError.message : responseError,
          ),
        }),
      );
      if (responseError instanceof GameError && responseError.status === 402)
        await finishSessionRun(game, "exhausted").catch(() => {});
      const timedOut =
        options.deadlineSignal?.aborted ??
        (responseError instanceof GameError && responseError.status === 504);
      const text =
        responseError instanceof GameError
          ? responseError.message
          : timedOut
            ? "The agent ran out of time for this response. Try again or ask for a shorter answer."
            : signal.aborted
              ? "Response stopped. Your run is still open."
              : "This response could not finish. Please try again.";
      await emit({
        kind: "error",
        text,
        ...(signal.aborted && { resumable: true }),
        ...(timedOut && { resumable: true, autoContinue: true }),
      }).catch(() => {});
    }
  } finally {
    clearInterval(heartbeat);
    signal.removeEventListener("abort", onSignal);
    for (const [toolCallId, dispatchId] of activeCommands) {
      const messages = (session?.messages ?? []) as Message[];
      const reported = messages.find(
        (message) => message.role === "toolResult" && message.toolCallId === toolCallId,
      );
      const interrupted: Message = reported ?? {
        role: "toolResult",
        toolCallId,
        toolName: "sprite_exec",
        content: [{ type: "text", text: "Execution status is unknown after interruption." }],
        isError: true,
        timestamp: Date.now(),
      };
      try {
        await completeAsyncCommand({
          dispatchId,
          gameId: game.id,
          sessionId,
          messages: reported ? messages : [...messages, interrupted],
          outcome: "unknown",
          output: textOf(interrupted),
        });
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "command.outcome.persistence_failed",
            gameId: game.id,
            dispatchId,
            error: diagnosticText(error instanceof Error ? error.message : error),
          }),
        );
      }
    }
    session?.dispose();
    const errors: unknown[] = [];
    if (directory)
      try {
        await rm(directory, { recursive: true, force: true });
      } catch (error) {
        errors.push(error);
      }
    try {
      await releaseSessionLease(game.id, sessionId, lease);
    } catch (error) {
      errors.push(error);
    }
    try {
      const { rows } = await db.query<GameRow>("SELECT * FROM ctf.games WHERE id=$1", [game.id]);
      if (rows[0]) send("done", await publicGame(rows[0], 0, sessionId));
    } catch (error) {
      errors.push(error);
    }
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length)
      console.error(
        JSON.stringify({
          event: "game.cleanup.failed",
          gameId: game.id,
          errors: errors.map((error) =>
            diagnosticText(error instanceof Error ? error.message : error),
          ),
        }),
      );
  }
}
