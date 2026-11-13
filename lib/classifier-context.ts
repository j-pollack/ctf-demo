import type { Message } from "@earendil-works/pi-ai";
import {
  buildMonitorDocument,
  MAX_MONITOR_DOCUMENT_BYTES,
  type MonitorDocumentOptions,
} from "./monitor-document";
import { TypesafeDocumentTooLargeError, type evaluate, type TypesafeQuestion } from "./typesafe";

// The provider is authoritative about token count; byte budgeting is only a packing estimate.
export async function evaluateClassifierContext(
  messages: Message[],
  options: Pick<MonitorDocumentOptions, "includeReasoning" | "proposedCommand">,
  questions: Record<string, TypesafeQuestion>,
  signal: AbortSignal,
  dispatch: (
    state: unknown,
    questions: Record<string, TypesafeQuestion>,
  ) => ReturnType<typeof evaluate>,
) {
  let maxBytes = MAX_MONITOR_DOCUMENT_BYTES - Buffer.byteLength(JSON.stringify(questions));
  let previousTranscript: string | undefined;
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    const document = buildMonitorDocument(messages, { ...options, maxBytes });
    const transcript = JSON.stringify(document.transcript);
    if (transcript === previousTranscript) throw new TypesafeDocumentTooLargeError();
    try {
      // Every attempt must pass through the caller's authorization and accounting boundary.
      return await dispatch(document, questions);
    } catch (error) {
      if (!(error instanceof TypesafeDocumentTooLargeError) || attempt >= 4) throw error;
      previousTranscript = transcript;
      maxBytes = Math.floor(Math.min(maxBytes, Buffer.byteLength(JSON.stringify(document))) * 0.8);
    }
  }
}
