import type { Message } from "@earendil-works/pi-ai";
import type { GameEvent } from "./types";

const unsafe = () => new Error("The run history cannot be safely forked.");
const textOf = (message: Message) =>
  typeof message.content === "string"
    ? message.content
    : message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");

// A fork goes back to just before the player's last instruction: the Pi transcript and the visible
// history are cut there, and the sprite is restored to the checkpoint taken at that instruction.
// The last user event must be that same instruction and carry its checkpoint, or the history is
// not safe to fork.
export function forkBeforeLastInstruction(messages: Message[], events: GameEvent[]) {
  const at = messages.findLastIndex((message) => message.role === "user");
  const eventAt = events.findLastIndex((event) => event.kind === "user");
  const event = events[eventAt];
  if (at < 0 || !event?.checkpoint || event.text !== textOf(messages[at])) throw unsafe();
  return {
    messages: messages.slice(0, at),
    events: events.slice(0, eventAt),
    instruction: event.text,
    checkpoint: event.checkpoint,
    userEventId: event.id,
  };
}
