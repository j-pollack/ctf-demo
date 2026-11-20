// Transport-only client for Jev, the control-game monitor, through OpenRouter's System One endpoint.
// The endpoint implements TypeSafe's request and response shapes.
// Docs: https://openrouter.ai/docs/guides/community/typesafe-sdk . Billing is per input token; no billing here.
// The model id is pinned to the 1.14 slug, not an alias, so calibrated thresholds don't drift with
// new releases. OpenRouter's slug carries no patch number.
export const TYPESAFE_MODEL = "typesafe/jev-1.14";

// A question is keyed by a name you choose; the answer comes back under the same name.
export type TypesafeQuestion =
  | { type: "noul"; instructions: string; criteria?: unknown }
  // Score criteria are ordered level descriptions; position is the level, starting at 0.
  | { type: "score"; instructions: string; criteria: string[] }
  // Choice criteria map each option name to a description of when it applies.
  | { type: "choice"; instructions: string; criteria: Record<string, string> };

export type TypesafeAnswer =
  | { type: "noul"; noul: number }
  | { type: "score"; score: number; confidence: number }
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> };

function finiteRange(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum
  );
}

function validateAnswer(
  name: string,
  question: TypesafeQuestion,
  answer: unknown,
): asserts answer is TypesafeAnswer {
  if (!answer || typeof answer !== "object")
    throw new Error(`Typesafe returned an invalid answer for "${name}".`);
  const value = answer as Record<string, unknown>;
  if (question.type === "noul") {
    if (value.type !== "noul" || !finiteRange(value.noul, 0, 1))
      throw new Error(`Typesafe returned an invalid answer for "${name}".`);
    return;
  }
  if (question.type === "score") {
    if (
      value.type !== "score" ||
      !finiteRange(value.score, 0, question.criteria.length - 1) ||
      !finiteRange(value.confidence, 0, 1)
    )
      throw new Error(`Typesafe returned an invalid answer for "${name}".`);
    return;
  }
  const choices = Object.keys(question.criteria);
  const probabilities = value.probabilities;
  if (
    value.type !== "choice" ||
    !choices.includes(String(value.choice)) ||
    !finiteRange(value.confidence, 0, 1) ||
    !probabilities ||
    typeof probabilities !== "object" ||
    Array.isArray(probabilities) ||
    Object.entries(probabilities).some(
      ([key, probability]) => !choices.includes(key) || !finiteRange(probability, 0, 1),
    )
  )
    throw new Error(`Typesafe returned an invalid answer for "${name}".`);
}

// OpenRouter serves Jev with a 262,144 token window and runs text requests over about 32,000 bytes
// in TypeSafe's long-context mode, so at our document cap this rejection is a backstop. The caller
// shrinks `state` and retries on 400 max_tokens_exceeded.
export class TypesafeDocumentTooLargeError extends Error {
  constructor() {
    super("Typesafe rejected the request as too large (max_tokens_exceeded).");
  }
}

const URL = "https://openrouter.ai/api/v1/systemone";

export async function evaluate(
  state: unknown,
  questions: Record<string, TypesafeQuestion>,
  signal?: AbortSignal,
): Promise<{ answers: Record<string, TypesafeAnswer>; inputTokens: number }> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is not set.");
  const response = await fetch(URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: TYPESAFE_MODEL, state, questions }),
    signal,
    cache: "no-store",
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    if (response.status === 400 && body.includes("max_tokens_exceeded"))
      throw new TypesafeDocumentTooLargeError();
    // 429 (rate limit) and 529 (overloaded) are retryable; the caller decides. The body can echo
    // request contents, so keep only the status in the message.
    throw new Error(`Typesafe request failed with status ${response.status}.`);
  }
  // A JSON syntax error quotes the text it could not parse, so it is replaced by a fixed message.
  const data = (await response.json().catch(() => {
    throw new Error("Typesafe returned an unreadable response.");
  })) as {
    answers?: Record<string, TypesafeAnswer>;
    usage?: { input_tokens?: number };
  };
  if (!data.answers || typeof data.answers !== "object" || Array.isArray(data.answers))
    throw new Error("Typesafe returned no answers.");
  for (const name of Object.keys(questions))
    if (!(name in data.answers)) throw new Error(`Typesafe omitted the answer for "${name}".`);
    else validateAnswer(name, questions[name], data.answers[name]);
  const inputTokens = data.usage?.input_tokens;
  if (!Number.isSafeInteger(inputTokens) || !finiteRange(inputTokens, 0, Number.MAX_SAFE_INTEGER))
    throw new Error("Typesafe returned invalid usage.");
  return { answers: data.answers, inputTokens };
}
