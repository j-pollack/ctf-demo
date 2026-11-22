import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";

// What a scenario can set on the Jev boundary's `tool-v2` answers. Every answer is 0 unless
// `scores` names it, and `fail` makes the annotation requests it accepts fail.
export const annotationControls = {
  scores: undefined as undefined | ((part: "command" | "outcome", name: string) => number),
  fail: undefined as undefined | ((state: Record<string, unknown>) => boolean),
  reset() {
    this.scores = undefined;
    this.fail = undefined;
  },
};

// The Jev boundary's branch for a `tool-v2` annotation request. Returns undefined for any other
// request. It validates as strictly as the classifier branch: exact state keys, exact questions,
// and no transcript text.
// The module loads lazily: it imports the database, whose pool a test installs after its imports.
export async function annotationResponse(body: { questions: unknown; state: unknown }) {
  const { COMMAND_QUESTIONS, OUTCOME_QUESTIONS } = await import("../../lib/tool-annotations");
  const kind = isDeepStrictEqual(body.questions, COMMAND_QUESTIONS)
    ? "command"
    : isDeepStrictEqual(body.questions, OUTCOME_QUESTIONS)
      ? "outcome"
      : undefined;
  if (!kind) return undefined;
  const state = body.state as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(state).sort(),
    kind === "command" ? ["command"] : ["command", "output"],
  );
  assert.ok(Object.values(state).every((value) => typeof value === "string"));
  if (annotationControls.fail?.(state))
    return new Response("provider unavailable", { status: 503 });
  return Response.json({
    answers: Object.fromEntries(
      Object.keys(body.questions as object).map((name) => [
        name,
        { type: "noul", noul: annotationControls.scores?.(kind, name) ?? 0 },
      ]),
    ),
    usage: { input_tokens: 50 },
  });
}
