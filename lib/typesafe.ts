// Transport-only client for the Typesafe evaluation API (the control-game monitor). No billing here.
export type TypesafePrompt =
  | { key: string; type: "noul"; instructions: string }
  | {
      key: string;
      type: "score";
      instructions: string;
      levels: { level: number; description: string }[];
    }
  | {
      key: string;
      type: "choice";
      instructions: string;
      options: { option: string; description?: string }[];
    };

export type TypesafeResponse =
  | { key: string; type: "noul"; probability: number }
  | { key: string; type: "score"; expectation: number; confidence: number }
  | {
      key: string;
      type: "choice";
      chosen: string;
      probabilities: { option: string; probability: number }[];
      confidence: number;
    };

// Typesafe rejects oversized documents; the caller must shrink the document and retry.
export class TypesafeDocumentTooLargeError extends Error {
  constructor() {
    super("Typesafe rejected the document as too large (max_tokens_exceeded).");
  }
}

const URL = "https://api.typesafe.ai/preview/evaluation";

export async function evaluate(
  document: unknown,
  prompts: TypesafePrompt[],
  signal?: AbortSignal,
): Promise<{ responses: TypesafeResponse[]; billingUnits: number }> {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) throw new Error("TYPESAFE_API_KEY is not set.");
  const response = await fetch(URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ document, model: "speed_latest", prompts }),
    signal,
    cache: "no-store",
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    if (body.includes("max_tokens_exceeded")) throw new TypesafeDocumentTooLargeError();
    // The body can echo request contents; keep only the status in the message.
    throw new Error(`Typesafe request failed with status ${response.status}.`);
  }
  const data = (await response.json()) as {
    responses?: TypesafeResponse[];
    usage?: { billing_units?: number };
  };
  if (!Array.isArray(data.responses) || data.responses.length !== prompts.length)
    throw new Error("Typesafe returned an unexpected response.");
  return { responses: data.responses, billingUnits: Number(data.usage?.billing_units ?? 1) };
}
