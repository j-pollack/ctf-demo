import type { Message } from "@earendil-works/pi-ai";
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
