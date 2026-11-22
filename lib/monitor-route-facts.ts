import type { Message } from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";
import { db } from "./db";
import { textOf } from "./inference";
import type { RouteFacts } from "./monitor-route";
import { INSTRUCTION_QUESTION_SET, SYSTEM_PROMPT_QUESTION_SET } from "./text-screen";
import {
  annotatableCalls,
  labelledCalls,
  TOOL_QUESTION_SET,
  unannotated,
} from "./tool-annotations";
import type { MonitorSnapshot } from "./types";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

// The hashes under which screens of the session's instructions and system prompts are stored.
function screenRefs(messages: readonly Message[], systemPrompt: string | undefined) {
  const users = messages.filter((message) => message.role === "user");
  const prompts = users.flatMap((message) => {
    const { systemPrompt: recorded } = message as { systemPrompt?: unknown };
    return typeof recorded === "string" ? [recorded] : [];
  });
  return {
    instruction: users.map((message) => sha256(textOf(message))),
    system_prompt: [...prompts, ...(systemPrompt ? [systemPrompt] : [])]
      .filter((text) => text.trim() !== "")
      .map(sha256),
  };
}

// Everything the route needs, read after the annotation pass so its rows are in.
export async function gatherRouteFacts(input: {
  final: boolean;
  sessionId: string;
  messages: readonly Message[];
  systemPrompt: string | undefined;
  commands: MonitorSnapshot["commands"];
}): Promise<RouteFacts> {
  const { final, sessionId, messages, commands } = input;
  const labelled = await labelledCalls(sessionId);
  const refs = screenRefs(messages, input.systemPrompt);
  const [stored, screens, missing] = await Promise.all([
    db.query<{ command_answers: Record<string, number>; outcome_answers: Record<string, number> }>(
      `SELECT command_answers,outcome_answers FROM ctf.tool_call_annotations
       WHERE session_id=$1 AND question_set=$2`,
      [sessionId, TOOL_QUESTION_SET],
    ),
    db.query<{ answers: Record<string, number> }>(
      `SELECT answers FROM ctf.text_screens WHERE session_id=$1 AND (
         (kind='instruction' AND question_set=$2 AND ref=ANY($4::text[]))
         OR (kind='system_prompt' AND question_set=$3 AND ref=ANY($5::text[])))`,
      [
        sessionId,
        INSTRUCTION_QUESTION_SET,
        SYSTEM_PROMPT_QUESTION_SET,
        refs.instruction,
        refs.system_prompt,
      ],
    ),
    unannotated(sessionId, annotatableCalls(messages, commands, labelled)),
  ]);
  return {
    final,
    answers: stored.rows.flatMap((row) => [row.command_answers, row.outcome_answers]),
    // A recorded operation can lack its command text.
    commands: commands
      .filter((operation) => operation.sessionId === sessionId)
      .flatMap((operation) => (typeof operation.command === "string" ? [operation.command] : [])),
    labelledOutputs: labelled.size,
    screens: screens.rows.map((row) => row.answers),
    unannotated: missing.length,
  };
}
