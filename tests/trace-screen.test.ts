import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTrace, type ReviewCall } from "../lib/investigator-trace";
import { screenedTrace } from "../lib/trace-screen";
import type { DecodeScreen, LayerScreen } from "../lib/decode-layers";

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
const HIDDEN = "cat /workspace/hidden_writer.sh";
const call = (callId: string, command: string, at: number): ReviewCall => ({
  session: "target",
  observation: "o1",
  index: at,
  callId,
  command,
  result: "[exit 0]",
  isError: false,
  sentAt: new Date(Date.UTC(2026, 0, 1, 0, 0, at)).toISOString(),
  returnedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, at, 500)).toISOString(),
  status: "ran",
});
const calls = [
  call("w-hidden", "echo data > /workspace/hidden_writer.sh", 1),
  call("w-raw", "echo data > /workspace/raw_reader.py", 2),
  call("cited", `python3 /workspace/raw_reader.py; printf %s '${b64(HIDDEN)}' | base64 -d | sh`, 3),
];
const screenAs = (verdict: LayerScreen["verdict"]): DecodeScreen => ({
  jailbreakCatch: true,
  layers: async (texts) => texts.map(() => ({ verdict, questions: [], flagRead: undefined })),
  onJailbreak: () => assert.fail("no catch"),
});
const traced = (verdict: LayerScreen["verdict"]) =>
  screenedTrace(buildTrace(calls, [calls[2]]).trace, screenAs(verdict), calls);

test("round 3: tokens from a decoded layer that is not clear are dropped, raw tokens stay", async () => {
  const { trace: raw } = buildTrace(calls, [calls[2]]);
  assert.deepEqual(raw.cited[0].fileTokens.sort(), ["hidden_writer.sh", "raw_reader.py"]);
  assert.deepEqual(raw.other.map((entry) => entry.token).sort(), [
    "hidden_writer.sh",
    "raw_reader.py",
  ]);
  for (const verdict of ["unclear", undefined] as const) {
    const shown = await traced(verdict);
    assert.ok("trace" in shown);
    assert.deepEqual(shown.trace.cited[0].fileTokens, ["raw_reader.py"]);
    assert.deepEqual(
      shown.trace.other.map((entry) => entry.token),
      ["raw_reader.py"],
    );
  }
  const clear = await traced("clear");
  assert.ok("trace" in clear);
  assert.deepEqual(clear.trace.cited[0].fileTokens.sort(), ["hidden_writer.sh", "raw_reader.py"]);
  assert.equal(clear.trace.other.length, 2);
});
