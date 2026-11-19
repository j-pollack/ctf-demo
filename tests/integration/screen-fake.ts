import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";

export type ScreenKind = "instruction" | "system_prompt" | "tool_output";
export type ScreenRequest = { kind: ScreenKind; state: Record<string, string>; at: number };
// "answer" replies; a number replies with that HTTP status; "hang" waits for the request's abort.
export type ScreenBehaviour = "answer" | "hang" | number;

// The Jev boundary's branch for a text-screening request (player-v1, system-v1 or output-v1).
// Returns undefined for any other request. It validates as strictly as the classifier branch:
// exact state keys, exact questions. Reports zero input tokens unless a scenario sets them.
// The module loads lazily: it imports the database, whose pool a test installs after its imports.
export function createScreenFake() {
  const requests: ScreenRequest[] = [];
  const controls = {
    tokens: { instruction: 0, system_prompt: 0, tool_output: 0 } as Record<ScreenKind, number>,
    // Chooses each request's reply from its kind and its position among that kind's requests.
    behave: (_kind: ScreenKind, _index: number): ScreenBehaviour => "answer",
    // Delays every answer, so a scenario can tell one screen's duration from another's.
    delayMs: 0,
    // Replaces the usage block of an answer, for the no-usage case.
    omitUsage: false,
  };
  const reset = () => {
    requests.length = 0;
    controls.tokens = { instruction: 0, system_prompt: 0, tool_output: 0 };
    controls.behave = () => "answer";
    controls.omitUsage = false;
    controls.delayMs = 0;
  };
  const response = async (body: { questions: unknown; state: unknown }, signal?: AbortSignal) => {
    const sets = await import("../../lib/text-screen");
    const kind: ScreenKind | undefined = isDeepStrictEqual(
      body.questions,
      sets.INSTRUCTION_QUESTIONS,
    )
      ? "instruction"
      : isDeepStrictEqual(body.questions, sets.SYSTEM_PROMPT_QUESTIONS)
        ? "system_prompt"
        : isDeepStrictEqual(body.questions, sets.OUTPUT_QUESTIONS)
          ? "tool_output"
          : undefined;
    if (!kind) return undefined;
    const state = body.state as Record<string, string>;
    assert.deepEqual(Object.keys(state), [kind === "tool_output" ? "output" : "text"]);
    assert.ok(Object.values(state).every((value) => typeof value === "string"));
    const index = requests.filter((request) => request.kind === kind).length;
    requests.push({ kind, state, at: performance.now() });
    const behaviour = controls.behave(kind, index);
    if (behaviour === "hang")
      await new Promise<never>((_resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    if (controls.delayMs) await new Promise((resolve) => setTimeout(resolve, controls.delayMs));
    if (typeof behaviour === "number")
      return new Response("fixture failure", { status: behaviour });
    return Response.json({
      answers: Object.fromEntries(
        Object.keys(body.questions as object).map((name) => [name, { type: "noul", noul: 0.25 }]),
      ),
      ...(controls.omitUsage ? {} : { usage: { input_tokens: controls.tokens[kind] } }),
    });
  };
  return { requests, controls, reset, response };
}
