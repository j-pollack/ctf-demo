import type { Message } from "@earendil-works/pi-ai";
import { instructionText, monitorVisibleMessage } from "./monitor-visibility";
import { TypesafeDocumentTooLargeError } from "./typesafe";

// Typesafe rejects large documents, so tool output (the bulky part) is clipped; commands,
// instructions and reasoning are never clipped.
export const MONITOR_OUTPUT_CLIP = 800;
// Jev's normal per-question window is 32k tokens. Its tokenizer is not exposed locally;
// this byte estimate leaves headroom, and the caller handles provider token-limit rejections.
// Through OpenRouter a text request over about 32,000 bytes runs in TypeSafe's long-context mode.
// The budget was kept by decision on 2026-11-18.
export const MAX_MONITOR_DOCUMENT_BYTES = (32_000 - 2_048) * 3;
export type MonitorDocumentOptions = {
  windowTurns?: number; // Explicit legacy calibration windows; production is size-budgeted.
  includeReasoning: boolean;
  proposedCommand?: string;
  maxBytes?: number;
};

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

function render(source: Message, includeReasoning: boolean): Turn | undefined {
  const message = monitorVisibleMessage(source);
  if (!message) return undefined;
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
    message.role === "user"
      ? instructionText(message)
      : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
  if (!text) return undefined;
  return message.role === "user" ? { role: "user", text } : { role: "tool", text: clip(text) };
}

export function buildMonitorDocument(
  messages: Message[],
  options: MonitorDocumentOptions,
): MonitorDocument {
  const agentIndexes = messages.flatMap((m, i) => (m.role === "assistant" ? [i] : []));
  const start =
    options.windowTurns === undefined
      ? 0
      : (agentIndexes[Math.max(0, agentIndexes.length - options.windowTurns)] ?? 0);
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
  // Never remove the evidence being classified just to make an oversized document fit.
  if (kept.length) kept[kept.length - 1].pinned = true;
  let sizeLimitMessages = 0;
  const document = (transcript: Turn[]): MonitorDocument => ({
    transcript,
    ...(options.proposedCommand === undefined ? {} : { proposedCommand: options.proposedCommand }),
    omissions: {
      olderMessages,
      sizeLimitMessages,
      clippedToolMessages,
      reasoningIncluded: options.includeReasoning,
    },
  });
  // Track serialized transcript bytes separately to avoid serializing the whole history per drop.
  let transcriptBytes =
    kept.reduce((bytes, item) => bytes + Buffer.byteLength(JSON.stringify(item.turn)), 0) +
    Math.max(0, kept.length - 1);
  const maxBytes = options.maxBytes ?? MAX_MONITOR_DOCUMENT_BYTES;
  // Drop oldest messages, preserving the latest instruction and latest visible evidence.
  for (;;) {
    if (Buffer.byteLength(JSON.stringify(document([]))) + transcriptBytes <= maxBytes) break;
    const oldest = kept.findIndex((item) => !item.pinned);
    if (oldest < 0) throw new TypesafeDocumentTooLargeError();
    const [dropped] = kept.splice(oldest, 1);
    transcriptBytes -= Buffer.byteLength(JSON.stringify(dropped.turn)) + (kept.length ? 1 : 0);
    if (dropped.turn.role === "tool" && dropped.turn.text.includes("…[+")) clippedToolMessages -= 1;
    sizeLimitMessages += 1;
  }
  return document(kept.map((item) => item.turn));
}

// The two Typesafe states for one proposed command. The command-only state carries no transcript, so
// planted text can't steer the command signals; the context state is the size-budgeted transcript.
export function monitorStates(messages: Message[], options: MonitorDocumentOptions) {
  return { command: options.proposedCommand, context: buildMonitorDocument(messages, options) };
}
