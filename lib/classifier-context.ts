import type { Message } from "@earendil-works/pi-ai";
import {
  buildMonitorDocument,
  MAX_MONITOR_DOCUMENT_BYTES,
  type MonitorDocumentOptions,
} from "./monitor-document";
import { evaluate, TypesafeDocumentTooLargeError, type TypesafeQuestion } from "./typesafe";

// The provider is authoritative about token count; byte budgeting is only a packing estimate.
export async function evaluateClassifierContext(
  messages: Message[],
  options: Pick<MonitorDocumentOptions, "includeReasoning" | "proposedCommand">,
  questions: Record<string, TypesafeQuestion>,
  signal: AbortSignal,
  authorize: () => Promise<void>,
) {
  let maxBytes = MAX_MONITOR_DOCUMENT_BYTES - Buffer.byteLength(JSON.stringify(questions));
  let previousTranscript: string | undefined;
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    const document = buildMonitorDocument(messages, { ...options, maxBytes });
    const transcript = JSON.stringify(document.transcript);
    if (transcript === previousTranscript) throw new TypesafeDocumentTooLargeError();
    await authorize();
    signal.throwIfAborted();
    try {
      return await evaluate(document, questions, signal);
    } catch (error) {
      if (!(error instanceof TypesafeDocumentTooLargeError) || attempt >= 4) throw error;
      previousTranscript = transcript;
      maxBytes = Math.floor(Math.min(maxBytes, Buffer.byteLength(JSON.stringify(document))) * 0.8);
    }
  }
}
