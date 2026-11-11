export const INVESTIGATION_TRACE_MAX_BYTES = 256 * 1024;
export const INVESTIGATION_TRACE_MAX_EVENTS = 64;

export type InvestigationRecordingError =
  | "trace-serialization-failed"
  | "observer-clone-failed"
  | "observer-callback-failed";

export type InvestigationToolResult = {
  toolName: string;
  toolCallId: string;
  arguments: unknown;
  isError: boolean;
  content: unknown;
};

export type InvestigationObserver = {
  onInitialEvidence: (evidence: unknown) => void;
  onToolResult: (result: InvestigationToolResult) => void;
  onRecordingError: (code: InvestigationRecordingError) => void;
};

export type InvestigationTraceEvent =
  | { sequence: number; type: "initialEvidence"; evidence: unknown }
  | { sequence: number; type: "toolResult"; result: InvestigationToolResult };

export type InvestigationTrace = {
  events: InvestigationTraceEvent[];
  omittedEvents: number;
  omittedBytes: number;
  recordingErrors: number;
  recordingErrorCodes: InvestigationRecordingError[];
};

function bytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function notifyInvestigationObserver<T>(
  observer: InvestigationObserver | undefined,
  method: "onInitialEvidence" | "onToolResult",
  value: T,
) {
  if (!observer) return;
  let copy: T;
  try {
    copy = structuredClone(value);
  } catch {
    try {
      observer.onRecordingError("observer-clone-failed");
    } catch {
      console.warn("Investigation diagnostic error callback failed.");
    }
    return;
  }
  try {
    if (method === "onInitialEvidence") observer.onInitialEvidence(copy);
    else observer.onToolResult(copy as InvestigationToolResult);
  } catch {
    try {
      observer.onRecordingError("observer-callback-failed");
    } catch {
      console.warn("Investigation diagnostic error callback failed.");
    }
  }
}

export function createInvestigationTraceRecorder(): {
  observer: InvestigationObserver;
  snapshot: () => InvestigationTrace;
} {
  let trace: InvestigationTrace = {
    events: [],
    omittedEvents: 0,
    omittedBytes: 0,
    recordingErrors: 0,
    recordingErrorCodes: [],
  };
  let sequence = 0;
  const fit = () => {
    while (bytes(trace) > INVESTIGATION_TRACE_MAX_BYTES && trace.events.length) {
      const removed = trace.events.at(-1)!;
      trace = {
        ...trace,
        events: trace.events.slice(0, -1),
        omittedEvents: trace.omittedEvents + 1,
        omittedBytes: trace.omittedBytes + bytes(removed),
      };
    }
  };
  const recordError = (code: InvestigationRecordingError) => {
    const codes = trace.recordingErrorCodes.includes(code)
      ? trace.recordingErrorCodes
      : [...trace.recordingErrorCodes, code];
    trace = { ...trace, recordingErrors: trace.recordingErrors + 1, recordingErrorCodes: codes };
    fit();
  };
  const record = (event: InvestigationTraceEvent) => {
    let copy: InvestigationTraceEvent;
    let eventBytes: number;
    try {
      const serialized = JSON.stringify(event);
      eventBytes = Buffer.byteLength(serialized, "utf8");
      copy = JSON.parse(serialized) as InvestigationTraceEvent;
    } catch {
      recordError("trace-serialization-failed");
      return;
    }
    if (trace.events.length < INVESTIGATION_TRACE_MAX_EVENTS) {
      const candidate = { ...trace, events: [...trace.events, copy] };
      if (bytes(candidate) <= INVESTIGATION_TRACE_MAX_BYTES) {
        trace = candidate;
        return;
      }
    }
    trace = {
      ...trace,
      omittedEvents: trace.omittedEvents + 1,
      omittedBytes: trace.omittedBytes + eventBytes,
    };
    // The omission counters are part of the cap, including when their width grows.
    fit();
  };
  return {
    observer: {
      onInitialEvidence: (evidence) =>
        record({ sequence: sequence++, type: "initialEvidence", evidence }),
      onToolResult: (result) => record({ sequence: sequence++, type: "toolResult", result }),
      onRecordingError: recordError,
    },
    snapshot: () => JSON.parse(JSON.stringify(trace)) as InvestigationTrace,
  };
}
