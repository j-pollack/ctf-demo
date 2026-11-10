import type { Message } from "@earendil-works/pi-ai";

// Typesafe rejects large documents, so tool output (the bulky part) is clipped; commands,
// instructions and reasoning are never clipped.
export const MONITOR_OUTPUT_CLIP = 800;
const MAX_DOCUMENT_BYTES = 60_000;

type Turn = { role: "user" | "agent" | "tool"; text: string };
export type MonitorDocument = {
  transcript: Turn[];
  proposedCommand?: string;
  omissions: {
    olderMessages: number;
    sizeLimitMessages: number;
    clippedToolMessages: number;
    reasoningIncluded: boolean;
  };
};

function clip(text: string) {
  return text.length > MONITOR_OUTPUT_CLIP
    ? `${text.slice(0, MONITOR_OUTPUT_CLIP)}\n…[+${text.length - MONITOR_OUTPUT_CLIP} chars]`
    : text;
}

function render(message: Message, includeReasoning: boolean): Turn | undefined {
  if (message.role === "assistant") {
    const text = message.content
      .flatMap((part) => {
        if (part.type === "text") return [part.text];
        if (part.type === "thinking") return includeReasoning ? [part.thinking] : [];
        const command = part.arguments?.command;
        return [
          `[${part.name}] ${typeof command === "string" ? command : JSON.stringify(part.arguments)}`,
        ];
      })
      .join("\n");
    return text ? { role: "agent", text } : undefined;
  }
  if (message.role !== "user" && message.role !== "toolResult") return undefined; // never system
  const text =
    typeof message.content === "string"
      ? message.content
      : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
  if (!text) return undefined;
  return message.role === "user" ? { role: "user", text } : { role: "tool", text: clip(text) };
}

export function buildMonitorDocument(
  messages: Message[],
  options: { windowTurns: number; includeReasoning: boolean; proposedCommand?: string },
): MonitorDocument {
  const agentIndexes = messages.flatMap((m, i) => (m.role === "assistant" ? [i] : []));
  const start = agentIndexes[Math.max(0, agentIndexes.length - options.windowTurns)] ?? 0;
  const lastUser = messages.findLastIndex((m) => m.role === "user");
  let olderMessages = 0;
  let clippedToolMessages = 0;
  // The player's latest instruction is always visible, even outside the window.
  const kept = messages
    .map((m, i) => {
      const turn = render(m, options.includeReasoning);
      if (i < start && i !== lastUser && turn) olderMessages += 1;
      if ((i >= start || i === lastUser) && turn?.role === "tool" && turn.text.includes("…[+"))
        clippedToolMessages += 1;
      return {
        turn: i >= start || i === lastUser ? turn : undefined,
        pinned: i === lastUser,
      };
    })
    .filter((item): item is { turn: Turn; pinned: boolean } => item.turn !== undefined);
  let sizeLimitMessages = 0;
  const document = (): MonitorDocument => ({
    transcript: kept.map((item) => item.turn),
    ...(options.proposedCommand === undefined ? {} : { proposedCommand: options.proposedCommand }),
    omissions: {
      olderMessages,
      sizeLimitMessages,
      clippedToolMessages,
      reasoningIncluded: options.includeReasoning,
    },
  });
  // Defensive cap: drop the oldest turns (never the latest instruction) until it fits.
  for (;;) {
    const oldest = kept.findIndex((item) => !item.pinned);
    if (oldest < 0 || JSON.stringify(document()).length <= MAX_DOCUMENT_BYTES) break;
    const [dropped] = kept.splice(oldest, 1);
    if (dropped.turn.role === "tool" && dropped.turn.text.includes("…[+")) clippedToolMessages -= 1;
    sizeLimitMessages += 1;
  }
  return document();
}

// The two Typesafe states for one proposed command. The command-only state carries no transcript, so
// planted text can't steer the command signals; the context state is the windowed transcript.
export function monitorStates(
  messages: Message[],
  options: { windowTurns: number; includeReasoning: boolean; proposedCommand?: string },
) {
  return { command: options.proposedCommand, context: buildMonitorDocument(messages, options) };
}
