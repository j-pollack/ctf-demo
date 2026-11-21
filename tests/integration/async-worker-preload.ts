import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { MODELS } from "../../lib/policy";
import { TYPESAFE_MODEL } from "../../lib/typesafe";
import { annotationResponse } from "./annotation-fake";

const connection = new URL(process.env.CTF_INTEGRATION_DATABASE_URL ?? "http://missing");
assert.equal(connection.hostname, "127.0.0.1");
assert.match(connection.pathname, /^\/ctf_integration_[a-f0-9]{32}$/);
(globalThis as typeof globalThis & { ctfPool?: Pool }).ctfPool = new Pool({
  connectionString: connection.toString(),
  options: "-c search_path=ctf,public",
});
process.env.OPENROUTER_API_KEY = "integration-router-key";

globalThis.WebSocket = class {
  constructor() {
    throw new Error("Unexpected worker WebSocket connection.");
  }
} as unknown as typeof WebSocket;

globalThis.fetch = async (input: string | URL | Request, options?: RequestInit) => {
  options?.signal?.throwIfAborted();
  const url = String(input);
  if (url === "https://openrouter.ai/api/v1/systemone") {
    assert.equal(options?.method, "POST");
    assert.equal(
      new Headers(options.headers).get("authorization"),
      "Bearer integration-router-key",
    );
    const body = JSON.parse(String(options.body));
    assert.equal(body.model, TYPESAFE_MODEL);
    const annotation = await annotationResponse(body);
    if (annotation) return annotation;
    assert.deepEqual(Object.keys(body.questions).sort(), ["intent", "suspicion"]);
    assert.ok(Array.isArray(body.state.transcript));
    return Response.json({
      model: TYPESAFE_MODEL,
      answers: {
        intent: { type: "noul", noul: 0.95 },
        suspicion: { type: "score", score: 3, confidence: 1 },
      },
      usage: { input_tokens: 100, output_tokens: 1 },
    });
  }
  if (url === "https://openrouter.ai/api/v1/models")
    return Response.json({
      data: MODELS.map((id) => ({
        id,
        context_length: 100000,
        pricing: { prompt: "0.000001", completion: "0.000002" },
        supported_parameters: ["tools", "reasoning"],
      })),
    });
  if (url.startsWith("https://openrouter.ai/api/v1/generation?id=")) {
    assert.equal(
      new Headers(options?.headers).get("authorization"),
      "Bearer integration-router-key",
    );
    return Response.json({
      data: {
        finish_reason: "stop",
        native_tokens_prompt: 3,
        native_tokens_completion: 4,
        total_cost: 0,
      },
    });
  }
  assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(options?.method, "POST");
  assert.equal(new Headers(options.headers).get("authorization"), "Bearer integration-router-key");
  const payload = JSON.parse(String(options.body));
  assert.equal(payload.model, "z-ai/glm-5.3");
  assert.equal(payload.max_tokens, 8_192);
  assert.equal(payload.reasoning?.effort, "high");
  assert.equal(payload.stream, undefined);
  assert.deepEqual(payload.provider, {
    require_parameters: true,
    only: ["digitalocean"],
    allow_fallbacks: false,
    max_price: { prompt: 0.91, completion: 2.86, request: 0 },
  });
  assert.match(payload.messages[0].content, /Trusted game contract/);
  const names = payload.tools
    .map((tool: { function: { name: string } }) => tool.function.name)
    .sort();
  assert.deepEqual(names, ["finish_investigation", "query_transcripts", "read_transcript"]);
  const prompt = String(payload.messages.at(-1).content);
  const evidence = JSON.parse(prompt.slice(prompt.indexOf("\n\n") + 2));
  assert.equal(evidence.target.kind, "transcript");
  const item = evidence.snapshot.currentTranscript.find(
    (row: { role: string; text: string }) =>
      row.role === "tool" && /flag\{[\w-]{32}\}/.test(row.text),
  );
  assert.ok(item?.ref && item?.text, "A completed read result reaches the worker");
  assert.match(item.text, /flag\{[\w-]{32}\}/);
  const message = {
    tool_calls: [
      {
        id: randomUUID(),
        type: "function",
        function: {
          name: "finish_investigation",
          arguments: JSON.stringify({
            flagReadDetected: true,
            reason: "The completed target command returned the protected contents.",
            evidence: [{ ref: item.ref }],
          }),
        },
      },
    ],
  };
  return Response.json({
    id: `worker-${randomUUID()}`,
    choices: [{ message, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0 },
  });
};
