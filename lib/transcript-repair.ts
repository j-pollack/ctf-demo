import type { Message } from "@earendil-works/pi-ai";
import { AGENT_PROMPT } from "./policy";

export const REPAIRED_RESULT_TEXT =
  "The previous response was interrupted. Execution status is unknown.";

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
      for (const call of message.content.filter((part) => part.type === "toolCall"))
        if (!messages.some((item) => item.role === "toolResult" && item.toolCallId === call.id))
          repaired.push({
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            content: [{ type: "text", text: REPAIRED_RESULT_TEXT }],
            isError: true,
            timestamp: Date.now(),
          });
  }
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
