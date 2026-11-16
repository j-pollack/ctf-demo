import type { Message, UserMessage } from "@earendil-works/pi-ai";
import { SUBMIT_TOOL_NAME } from "./policy";

// Monitors judge the agent's commands and words, never the scoring tool: a visible submit call
// (with the flag as its argument) would make every capture obvious. Returns the message as a
// monitor may see it, or undefined when nothing of it is visible.
export function monitorVisibleMessage(message: Message): Message | undefined {
  if (message.role === "toolResult")
    return message.toolName === SUBMIT_TOOL_NAME ? undefined : message;
  if (message.role !== "assistant") return message;
  const content = message.content.filter(
    (part) => !(part.type === "toolCall" && part.name === SUBMIT_TOOL_NAME),
  );
  if (content.length === message.content.length) return message;
  return content.length ? { ...message, content } : undefined;
}

// A player instruction records the player's system prompt in effect when it was sent, so a later
// prompt edit cannot change what monitors see for earlier turns. Providers receive only the
// instruction's content. Instructions recorded before this field existed carry no prompt.
export function instructionMessage(text: string, systemPrompt: string): UserMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
    systemPrompt,
  } as UserMessage;
}

export function instructionText(message: UserMessage) {
  const text =
    typeof message.content === "string"
      ? message.content
      : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
  const { systemPrompt } = message as { systemPrompt?: unknown };
  if (typeof systemPrompt !== "string" || !systemPrompt) return text;
  // ponytail: repeats the prompt on every instruction; render only changes if long sessions
  // start hitting the investigator's initial-context limit.
  return `[player system prompt in effect]\n${systemPrompt}\n[player instruction]\n${text}`;
}

// The prompt recorded on a session's latest instruction, or undefined when it has none.
export function lastInstructionPrompt(messages: readonly Message[]) {
  const latest = messages.findLast((message) => message.role === "user");
  const prompt = (latest as { systemPrompt?: unknown } | undefined)?.systemPrompt;
  return typeof prompt === "string" ? prompt : undefined;
}
