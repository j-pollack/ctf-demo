import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { GameEvent } from "./types";

const successful = (message: Message): message is AssistantMessage =>
  message.role === "assistant" &&
  message.stopReason !== "error" &&
  message.stopReason !== "aborted";
const text = (message: Message) =>
  typeof message.content === "string"
    ? message.content
    : message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");

export function forkTranscript(
  messages: Message[],
  events: GameEvent[],
  turns: number,
  eventId: number,
) {
  const agents = events.filter((event) => event.kind === "agent");
  const assistants = messages.filter(successful);
  if (
    assistants.length !== turns ||
    agents.length !== turns ||
    agents.some((event, index) => {
      const message = assistants[index];
      return (
        event.turn !== index + 1 ||
        !message ||
        event.model !== message.model ||
        event.text !== text(message)
      );
    })
  )
    throw new Error("The run history cannot be safely forked.");
  const selected = events.findIndex((event) => event.id === eventId && event.kind === "agent");
  if (selected < 0) throw new Error("The selected response cannot be safely forked.");
  const turn = events[selected].turn;
  if (turn === undefined || turn < 1)
    throw new Error("The selected response cannot be safely forked.");
  const boundary = messages.indexOf(assistants[turn - 1]);
  if (boundary < 0) throw new Error("The selected response cannot be safely forked.");
  const prefix = events.slice(0, selected + 1);
  return {
    messages: messages.slice(0, boundary + 1),
    events: prefix,
    turns: turn,
    blocks: prefix.filter((event) => event.kind === "monitor" && event.decision === "block").length,
  };
}
