import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createInvestigationTraceRecorder,
  notifyInvestigationObserver,
} from "../lib/investigation-trace";

test("trace keeps detached input and output snapshots with ordered sequence gaps", () => {
  const trace = createInvestigationTraceRecorder();
  const initial = {
    target: { kind: "transcript" },
    snapshot: { currentTranscript: [{ text: "read-ok" }] },
  };
  trace.observer.onInitialEvidence(initial);
  initial.snapshot.currentTranscript[0].text = "changed";
  for (let i = 0; i < 65; i++)
    trace.observer.onToolResult({
      toolName: "query_transcripts",
      toolCallId: String(i),
      arguments: { sql: "SELECT 1" },
      isError: false,
      content: [{ type: "text", text: String(i) }],
    });
  const first = trace.snapshot();
  assert.equal(first.events.length, 64);
  assert.equal(first.omittedEvents, 2);
  assert.ok(first.omittedBytes > 0);
  assert.equal(first.events[0].sequence, 0);
  assert.equal(first.events[0].type, "initialEvidence");
  assert.equal(JSON.stringify(first.events[0]).includes("read-ok"), true);
  (
    first.events[0] as { evidence: { snapshot: { currentTranscript: { text: string }[] } } }
  ).evidence.snapshot.currentTranscript[0].text = "output mutation";
  assert.equal(JSON.stringify(trace.snapshot().events[0]).includes("read-ok"), true);
});

test("trace bounds the whole UTF-8 JSON envelope and reports complete omitted events", () => {
  const trace = createInvestigationTraceRecorder();
  trace.observer.onInitialEvidence({ text: "🙂".repeat(70_000) });
  trace.observer.onToolResult({
    toolName: "read_transcript",
    toolCallId: "1",
    arguments: {},
    isError: false,
    content: [{ type: "text", text: "exact page" }],
  });
  const snapshot = trace.snapshot();
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot), "utf8") <= 256 * 1024);
  assert.equal(snapshot.omittedEvents, 1);
  assert.ok(snapshot.omittedBytes >= 280_000);
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.events[0].sequence, 1);
  assert.ok(JSON.stringify(snapshot.events).includes("exact page"));
});

test("trace reports serialization failures using fixed codes", () => {
  const trace = createInvestigationTraceRecorder();
  const circular: { self?: unknown } = {};
  circular.self = circular;
  trace.observer.onInitialEvidence(circular);
  trace.observer.onRecordingError("observer-callback-failed");
  const snapshot = trace.snapshot();
  assert.equal(snapshot.events.length, 0);
  assert.equal(snapshot.recordingErrors, 2);
  assert.deepEqual(snapshot.recordingErrorCodes, [
    "trace-serialization-failed",
    "observer-callback-failed",
  ]);
});

test("recording errors preserve the total cap after a nearly full event", () => {
  const make = (length: number) => {
    const trace = createInvestigationTraceRecorder();
    trace.observer.onInitialEvidence({ text: "x".repeat(length) });
    return trace;
  };
  let low = 0;
  let high = 256 * 1024;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (make(middle).snapshot().events.length) low = middle;
    else high = middle;
  }
  const trace = make(low);
  trace.observer.onRecordingError("observer-clone-failed");
  const snapshot = trace.snapshot();
  assert.equal(snapshot.recordingErrors, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot), "utf8") <= 256 * 1024);
  assert.equal(snapshot.events.length, 0);
  assert.equal(snapshot.omittedEvents, 1);
  assert.ok(snapshot.omittedBytes > 0);
});

test("a noncloneable observer payload records a safe code", () => {
  const trace = createInvestigationTraceRecorder();
  notifyInvestigationObserver(trace.observer, "onInitialEvidence", { invalid: () => undefined });
  assert.equal(trace.snapshot().events.length, 0);
  assert.deepEqual(trace.snapshot().recordingErrorCodes, ["observer-clone-failed"]);
});
