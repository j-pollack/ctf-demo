import { test } from "node:test";
import assert from "node:assert/strict";
import { diagnosticText, getModel, providerErrorDetails } from "../lib/inference";
import { MONITOR_MODEL } from "../lib/policy";

test("provider diagnostics retain rate-limit evidence and redact credentials and flags", () => {
  const previous = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-private-key";
  try {
    const response = new Response(null, {
      status: 429,
      headers: { "x-request-id": "provider-request", "retry-after": "12" },
    });
    const details = providerErrorDetails(response, {
      error: {
        code: 429,
        message: "Provider rate limit test-private-key flag{secret}",
        metadata: {
          provider_name: "Test provider",
          limit_source: "upstream_provider_shared_pool",
          provider_code: "TooManyRequests",
          remedy_hint: "Retry shortly",
          headers: { "X-RateLimit-Remaining": "0" },
          raw: JSON.stringify({
            error: { message: "Quota exceeded test-private-key flag{secret}" },
            request: { messages: ["private transcript"] },
          }),
        },
      },
    });
    assert.equal(details.provider, "Test provider");
    assert.equal(details.limitSource, "upstream_provider_shared_pool");
    assert.equal(details.providerCode, "TooManyRequests");
    assert.equal(details.headers["retry-after"], "12");
    assert.equal(details.headers["x-ratelimit-remaining"], "0");
    assert.equal(details.upstreamMessage, "Quota exceeded [redacted] [redacted flag]");
    assert.doesNotMatch(
      JSON.stringify(details),
      /test-private-key|flag\{secret\}|private transcript/,
    );
    assert.equal(diagnosticText("Bearer other-private-token"), "Bearer [redacted]");
    assert.equal(diagnosticText("x".repeat(3000))?.length, 2000);
    assert.equal(providerErrorDetails(response, null).message, undefined);
    assert.equal(
      providerErrorDetails(response, {
        error: { metadata: { raw: "<html>unstructured body</html>" } },
      }).upstreamMessage,
      undefined,
    );
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
  }
});

test("a monitor without reasoning support is accepted, while an agent requires reasoning", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      data: [
        {
          id: MONITOR_MODEL,
          context_length: 100000,
          pricing: { prompt: "0.000001", completion: "0.000002" },
          supported_parameters: ["tools", "response_format"],
        },
      ],
    });
  try {
    assert.equal((await getModel(MONITOR_MODEL, "monitor")).reasoning, false);
    await assert.rejects(
      () => getModel(MONITOR_MODEL, "agent"),
      /does not support readable reasoning/,
    );
  } finally {
    globalThis.fetch = previous;
  }
});
