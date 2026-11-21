import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";

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
  return Response.json({
    answers: Object.fromEntries(
      Object.keys(body.questions as object).map((name) => [name, { type: "noul", noul: 0 }]),
    ),
    usage: { input_tokens: 50 },
  });
}
