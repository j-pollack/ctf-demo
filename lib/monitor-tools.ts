import { createHash } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";
import type { MonitorSnapshot } from "./types";
import { instructionText, monitorVisibleMessage } from "./monitor-visibility";

export const MONITOR_MESSAGE_CHUNK_JSON_BYTES = 2_500;

export type MonitorEvidenceMessage = {
  ref: string;
  sessionId: string;
  index: number;
  role: "user" | "agent" | "tool";
  text: string;
  sha256: string;
  chunkIndex: number;
  chunkCount: number;
  toolCalls?: { id: string; name: string }[];
  toolCallId?: string;
  toolError?: boolean;
  // Tool results only: server times, ISO 8601 UTC, of the request that ran the command. Null when unknown.
  sentAt?: string | null;
  returnedAt?: string | null;
  commandStates?: {
    toolCallId: string;
    state: "proposed" | "admitted" | "completed" | "interrupted" | "unknown";
  }[];
};
function digest(text: string) {
  return createHash("sha256").update(text).digest("hex");
}
export function monitorSessionAlias(snapshot: MonitorSnapshot, rawId: string) {
  return `s_${digest(`${snapshot.snapshotId}:${rawId}`).slice(0, 24)}`;
}

export function visibleText(
  source: Message,
  includeReasoning: boolean,
):
  | {
      role: MonitorEvidenceMessage["role"];
      text: string;
      toolCalls?: MonitorEvidenceMessage["toolCalls"];
      toolCallId?: string;
      toolError?: boolean;
    }
  | undefined {
  const message = monitorVisibleMessage(source);
  if (!message || message.role === "system") return undefined;
  if (message.role === "user" || message.role === "toolResult") {
    const text =
      message.role === "user"
        ? instructionText(message)
        : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
    if (!text) return undefined;
    return {
      role: message.role === "user" ? "user" : "tool",
      text,
      ...(message.role === "toolResult"
        ? { toolCallId: message.toolCallId, toolError: message.isError }
        : {}),
    };
  }
  if (message.role !== "assistant") return undefined;
  const toolCalls = message.content.flatMap((part) =>
    part.type === "toolCall" ? [{ id: part.id, name: part.name }] : [],
  );
  const pieces = message.content.flatMap((part) => {
    if (part.type === "text") return [part.text];
    if (part.type === "thinking") return includeReasoning ? [`[reasoning]\n${part.thinking}`] : [];
    return [`[tool call ${part.name} id=${part.id}] ${JSON.stringify(part.arguments)}`];
  });
  const text = pieces.join("\n");
  return text ? { role: "agent", text, ...(toolCalls.length ? { toolCalls } : {}) } : undefined;
}

const EMPTY_CHUNK_JSON_BYTES = Buffer.byteLength(JSON.stringify({ text: "" }), "utf8");

function chunkText(text: string) {
  const chunks: string[] = [];
  let chunk = "";
  let bytes = EMPTY_CHUNK_JSON_BYTES;
  for (const character of text) {
    // JSON.stringify escapes each code point independently, so sizes add up.
    const characterBytes = Buffer.byteLength(JSON.stringify(character), "utf8") - 2;
    if (chunk && bytes + characterBytes > MONITOR_MESSAGE_CHUNK_JSON_BYTES) {
      chunks.push(chunk);
      chunk = "";
      bytes = EMPTY_CHUNK_JSON_BYTES;
    }
    chunk += character;
    bytes += characterBytes;
  }
  if (chunk || chunks.length === 0) chunks.push(chunk);
  return chunks;
}

function commandState(
  snapshot: MonitorSnapshot,
  sessionId: string,
  callId: string | undefined,
  proposed = false,
) {
  if (!callId) return undefined;
  const command = snapshot.commands.findLast(
    (item) => item.sessionId === sessionId && item.toolCallId === callId,
  );
  if (!command)
    return proposed
      ? {
          toolCallId: callId,
          state: "proposed" as const,
        }
      : undefined;
  const state: NonNullable<MonitorEvidenceMessage["commandStates"]>[number]["state"] =
    command.outcome === "completed"
      ? "completed"
      : command.outcome === "interrupted"
        ? "interrupted"
        : command.outcome === "unknown"
          ? "unknown"
          : command.admittedRevision === null
            ? "proposed"
            : "admitted";
  return {
    toolCallId: callId,
    state,
  };
}

export function evidenceMessages(
  snapshot: MonitorSnapshot,
  sessionId: string,
  messages: readonly Message[],
  includeReasoning: boolean,
): MonitorEvidenceMessage[] {
  const times = new Map(
    (snapshot.operationTimes ?? [])
      .filter((time) => time.sessionId === sessionId)
      .map((time) => [time.toolCallId, time]),
  );
  return messages.flatMap((message, index) => {
    const rendered = visibleText(message, includeReasoning);
    if (!rendered) return [];
    const sha256 = digest(rendered.text);
    const chunks = chunkText(rendered.text);
    const chunkCount = chunks.length;
    return chunks.map((text, chunkIndex) => ({
      ref: `msg:${snapshot.snapshotId}:${monitorSessionAlias(snapshot, sessionId)}:${index}${chunkCount > 1 ? `#${chunkIndex}` : ""}`,
      sessionId: monitorSessionAlias(snapshot, sessionId),
      index,
      role: rendered.role,
      text,
      sha256,
      chunkIndex,
      chunkCount,
      ...(rendered.toolCalls ? { toolCalls: rendered.toolCalls } : {}),
      ...(rendered.toolCallId ? { toolCallId: rendered.toolCallId } : {}),
      ...(rendered.toolError === undefined ? {} : { toolError: rendered.toolError }),
      ...(rendered.toolCallId
        ? {
            sentAt: times.get(rendered.toolCallId)?.sentAt ?? null,
            returnedAt: times.get(rendered.toolCallId)?.returnedAt ?? null,
          }
        : {}),
      ...(() => {
        const calls = rendered.toolCalls?.filter((call) => call.name === "sprite_exec") ?? [];
        const callIds = calls.map((call) => ({ id: call.id, proposed: true }));
        if (rendered.toolCallId) callIds.push({ id: rendered.toolCallId, proposed: false });
        const states = callIds.flatMap(({ id, proposed }) => {
          const state = commandState(snapshot, sessionId, id, proposed);
          return state ? [state] : [];
        });
        return states.length ? { commandStates: states } : {};
      })(),
    }));
  });
}
