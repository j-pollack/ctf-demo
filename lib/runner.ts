import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, Type, type Message } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  defineTool,
} from "@earendil-works/pi-coding-agent";
import { db } from "./db";
import { assertLease, cleanup, gameBilling, publicGame, record, type GameRow } from "./games";
import { agentStream, diagnosticText, getModel, infer, reasoningOf, textOf } from "./inference";
import {
  AGENT_PROMPT,
  agentPrompt as withSubmitInstruction,
  GameError,
  hasSecret,
  MONITOR_PROMPT,
  monitorPayload,
  parseDecision,
} from "./policy";
import { executeCommand } from "./sprites";
import type { GameEvent } from "./types";

export function repairMessages(messages: Message[], prompt = AGENT_PROMPT): Message[] {
  const repaired: Message[] = [];
  for (const message of messages) {
    if (
      message.role === "assistant" &&
      (message.stopReason === "error" || message.stopReason === "aborted")
    )
      continue;
    repaired.push(message);
    if (message.role === "assistant")
      for (const call of message.content.filter((part) => part.type === "toolCall")) {
        if (!messages.some((item) => item.role === "toolResult" && item.toolCallId === call.id))
          repaired.push({
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            content: [
              {
                type: "text",
                text: "The previous response was interrupted. Execution status is unknown.",
              },
            ],
            isError: true,
            timestamp: Date.now(),
          });
      }
  }
  // Agent.prompt skips AgentSession's initial prompt setup. Seed it explicitly,
  // including transcripts created before this fix with an empty leading system message.
  const first = repaired[0];
  if (first?.role === "system")
    repaired[0] = { ...first, sections: { ...first.sections, preamble: prompt } };
  else
    repaired.unshift({
      role: "system",
      content: "",
      sections: { preamble: prompt },
      timestamp: Date.now(),
    });
  return repaired;
}
export async function runGame(
  game: GameRow,
  prompt: string,
  signal: AbortSignal,
  send: (type: string, data: unknown) => void,
) {
  const agentPrompt = withSubmitInstruction(game.system_prompt);
  const directory = await mkdtemp(join(tmpdir(), "tripwire-"));
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let failure: unknown;
  // The agent's current streaming phase, shown as the status line.
  let phase = "";
  const emit = async (event: Omit<GameEvent, "id">) => {
    send("event", await record(game.id, event, game.lease));
    // Best effort: the live totals must never turn a recorded event into a failed response.
    await gameBilling(game.id)
      .then((billing) => send("billing", billing))
      .catch((error) =>
        console.error(
          JSON.stringify({
            event: "billing.read.failed",
            timestamp: new Date().toISOString(),
            gameId: game.id,
            error: diagnosticText(error instanceof Error ? error.message : error),
          }),
        ),
      );
  };
  try {
    const [model, monitor] = await Promise.all([
      getModel(game.agent_model, "agent"),
      getModel(game.monitor_model, "monitor"),
    ]);
    const season = (
      await db.query("SELECT monitor_prompt FROM ctf.seasons WHERE id=$1", [game.season_id])
    ).rows[0];
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
      systemPromptOverride: () => agentPrompt,
    });
    await loader.reload();
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    const manager = SessionManager.inMemory(directory);
    repairMessages(game.messages, agentPrompt).forEach((message) => manager.appendMessage(message));
    const tool = defineTool({
      name: "sprite_exec",
      label: "Game command",
      description:
        "Run a shell command in this game's isolated Linux environment. Commands are reviewed by the monitor before execution.",
      parameters: Type.Object(
        { command: Type.String({ minLength: 1, maxLength: 8192 }) },
        { additionalProperties: false },
      ),
      executionMode: "sequential",
      execute: async (_id, { command }, toolSignal) => {
        await assertLease(game);
        const text = await executeCommand(game.sprite_name, command, toolSignal);
        return { content: [{ type: "text" as const, text }], details: {} };
      },
    });
    const submit = defineTool({
      name: "submit",
      label: "Submit",
      description:
        "Submit your final result. This ends the run immediately, whatever the value. Call it once, when you are done.",
      parameters: Type.Object(
        { value: Type.String({ maxLength: 8192 }) },
        { additionalProperties: false },
      ),
      executionMode: "sequential",
      execute: async (_id, { value }) => {
        await assertLease(game);
        const correct = hasSecret(value, game.secret_hash);
        const ended = await db.query(
          correct
            ? "UPDATE ctf.games g SET status='captured' FROM ctf.seasons s WHERE g.season_id=s.id AND g.id=$1 AND lease=$2 AND g.status='active' AND (s.ends_at IS NULL OR s.ends_at>now())"
            : "UPDATE ctf.games SET status='ended' WHERE id=$1 AND lease=$2 AND status='active'",
          [game.id, game.lease],
        );
        if (correct && !ended.rowCount) {
          // The catch below marks the run ended; no later call in this batch may run.
          game.status = "ended";
          failure = new GameError("This season has ended. Start a new run.", 410);
          session!.agent.abort();
        } else {
          game.status = correct ? "captured" : "ended";
          await emit({ kind: "submit", text: value, correct, turn: game.turns });
        }
        return { content: [{ type: "text" as const, text: "Submitted." }], details: {} };
      },
    });
    ({ session } = await createAgentSession({
      cwd: directory,
      agentDir: directory,
      modelRuntime: runtime,
      model,
      thinkingLevel: "medium",
      tools: ["sprite_exec", "submit"],
      noTools: "builtin",
      customTools: [tool, submit],
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
        failure ??= error;
      },
      (stage) => send("stage", stage),
      (delta) => {
        // The status follows what the agent is producing right now.
        const next = delta.tool
          ? "Tool called"
          : delta.text
            ? "Agent responding"
            : "Agent thinking";
        if (next !== phase) send("stage", (phase = next));
        if (delta.reasoning || delta.text)
          send("delta", {
            ...(delta.reasoning && { reasoning: delta.reasoning }),
            ...(delta.text && { text: delta.text }),
          });
      },
    );
    session.agent.toolExecution = "sequential";
    session.agent.beforeToolCall = async ({ assistantMessage, toolCall }, toolSignal) => {
      // A submission ends the run: nothing after it runs, including later calls in the same batch.
      if (game.status !== "active")
        return { block: true, reason: "The run is over.", terminate: true };
      const args = toolCall.arguments;
      // Submitting executes nothing in the environment, so the monitor never reviews it.
      if (toolCall.name === "submit")
        return Value.Check(submit.parameters, args)
          ? undefined
          : { block: true, reason: "Invalid submit arguments" };
      if (!Value.Check(tool.parameters, args))
        return { block: true, reason: "Invalid command arguments" };
      const command = args.command as string;
      try {
        await assertLease(game);
        if (!reasoningOf(assistantMessage).trim())
          throw new Error(
            "Readable agent reasoning was unavailable. The command was not executed.",
          );
        send("stage", "Monitor reviewing command");
        // Pi's hook context can omit earlier results in a batch; the session has every completed message.
        const messages: Message[] = [
          {
            role: "system",
            content: season.monitor_prompt ?? MONITOR_PROMPT,
            timestamp: Date.now(),
          },
          {
            role: "user",
            content: JSON.stringify(monitorPayload(session!.messages, toolCall)),
            timestamp: Date.now(),
          },
        ];
        const response = await infer(game, "monitor", monitor, messages, toolSignal, (stage) =>
          send("stage", stage),
        );
        let decision;
        try {
          decision = parseDecision(textOf(response));
        } catch {
          throw new GameError(
            "The monitor returned an invalid decision. The command was not executed.",
            503,
          );
        }
        await assertLease(game);
        await emit({
          kind: "monitor",
          text: decision.reason,
          command,
          decision: decision.allow ? "allow" : "block",
          turn: game.turns,
        });
        if (!decision.allow) {
          game.blocks++;
          await db.query("UPDATE ctf.games SET blocks=blocks+1 WHERE id=$1 AND lease=$2", [
            game.id,
            game.lease,
          ]);
          // The explanation lives only in the UI event, never in Pi's replayed transcript.
          return { block: true, reason: "Blocked" };
        }
        send("stage", "Running command");
        return undefined;
      } catch (error) {
        failure = error;
        console.error(
          JSON.stringify({
            event: "monitor.failed",
            timestamp: new Date().toISOString(),
            gameId: game.id,
            model: game.monitor_model,
            turn: game.turns,
            error: diagnosticText(error instanceof Error ? error.message : error),
          }),
        );
        session!.agent.abort();
        const text =
          error instanceof GameError
            ? error.message
            : error instanceof Error && error.message.startsWith("Readable")
              ? error.message
              : "The monitor could not make a valid decision. The command was not executed.";
        await emit({ kind: "monitor", text, command, decision: "error", turn: game.turns });
        return { block: true, reason: text, terminate: true };
      }
    };
    session.agent.subscribe(async (event) => {
      if (event.type === "turn_start") send("stage", (phase = "Agent thinking"));
      if (event.type !== "message_end") return;
      const message = event.message as Message;
      if (message.role === "user") await emit({ kind: "user", text: textOf(message) });
      if (
        message.role === "assistant" &&
        message.stopReason !== "error" &&
        message.stopReason !== "aborted"
      ) {
        game.turns++;
        await db.query("UPDATE ctf.games SET turns=turns+1 WHERE id=$1 AND lease=$2", [
          game.id,
          game.lease,
        ]);
        const calls = message.content
          .flatMap((part) =>
            part.type === "toolCall" && part.name === "sprite_exec"
              ? [String(part.arguments.command ?? "")]
              : [],
          )
          .join("\n");
        await emit({
          kind: "agent",
          text: textOf(message),
          reasoning: reasoningOf(message),
          command: calls || undefined,
          turn: game.turns,
          model: message.model,
        });
      }
      if (message.role === "toolResult" && message.toolName !== "submit")
        await emit({ kind: "tool", text: textOf(message), turn: game.turns });
      const messages = session!.messages as Message[];
      await db.query("UPDATE ctf.games SET messages=$3,updated_at=now() WHERE id=$1 AND lease=$2", [
        game.id,
        game.lease,
        JSON.stringify(messages),
      ]);
      // Stop once the submission's result is saved; the agent gets no further turn.
      if (message.role === "toolResult" && game.status !== "active") session!.agent.abort();
    });
    const abort = () => session!.agent.abort();
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted) throw new Error("Response stopped.");
      // Raw Agent.prompt avoids harness slash commands and host @file expansion.
      await session.agent.prompt(prompt);
    } finally {
      signal.removeEventListener("abort", abort);
    }
    if (failure && game.status !== "captured") throw failure;
    if (signal.aborted)
      await emit({ kind: "error", text: "Response stopped. Your run is still open." });
  } catch (error) {
    if (game.status === "captured") return;
    console.error(
      JSON.stringify({
        event: "game.response.failed",
        timestamp: new Date().toISOString(),
        gameId: game.id,
        error: diagnosticText(error instanceof Error ? error.message : error),
      }),
    );
    if (error instanceof GameError && error.status === 402)
      await db.query(
        "UPDATE ctf.games SET status='exhausted' WHERE id=$1 AND lease=$2 AND status='active'",
        [game.id, game.lease],
      );
    if (error instanceof GameError && error.status === 410)
      await db.query(
        "UPDATE ctf.games SET status='ended' WHERE id=$1 AND lease=$2 AND status='active'",
        [game.id, game.lease],
      );
    const text =
      error instanceof GameError
        ? error.message
        : signal.aborted
          ? "Response stopped. Your run is still open."
          : "This response could not finish. Please try again.";
    await emit({ kind: "error", text });
  } finally {
    session?.dispose();
    await rm(directory, { recursive: true, force: true });
    const finished = await db.query<GameRow>(
      "UPDATE ctf.games SET lease=NULL,lease_until=NULL WHERE id=$1 AND lease=$2 RETURNING *",
      [game.id, game.lease],
    );
    if (finished.rows[0]) send("done", await publicGame(finished.rows[0]));
    await cleanup();
  }
}
