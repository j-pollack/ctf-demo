// Transport-only client for the Typesafe (Jev) System One API, the control-game monitor.
// Docs: https://docs.typesafe.ai/api/system-one . Billing is per input token; no billing here.
// Pin a versioned model so calibrated thresholds don't drift when the `jev-latest` alias moves.
export const TYPESAFE_MODEL = "jev-1.13.0";

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

// Jev rejects a request longer than its context limit (400 max_tokens_exceeded); the caller must
// shrink `state` and retry.
export class TypesafeDocumentTooLargeError extends Error {
  constructor() {
    super("Typesafe rejected the request as too large (max_tokens_exceeded).");
  }
}

const URL = "https://api.typesafe.ai/v1/systemone";

export async function evaluate(
  state: unknown,
  questions: Record<string, TypesafeQuestion>,
  signal?: AbortSignal,
): Promise<{ answers: Record<string, TypesafeAnswer>; inputTokens: number }> {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) throw new Error("TYPESAFE_API_KEY is not set.");
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
  const data = (await response.json()) as {
    answers?: Record<string, TypesafeAnswer>;
    usage?: { input_tokens?: number };
  };
  if (!data.answers || typeof data.answers !== "object")
    throw new Error("Typesafe returned no answers.");
  for (const name of Object.keys(questions))
    if (!(name in data.answers)) throw new Error(`Typesafe omitted the answer for "${name}".`);
  return { answers: data.answers, inputTokens: Number(data.usage?.input_tokens ?? 0) };
}
