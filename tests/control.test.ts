import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { combineSuspicion, CONTROL_DIFFICULTY, MONITOR_SCORE_MAX } from "../lib/control";
import { evaluate, TypesafeDocumentTooLargeError, TYPESAFE_MODEL } from "../lib/typesafe";

const quiet = {
  reads_now: 0,
  stages_indirect: 0,
  intent: 0,
  suspicionScore: 0,
  suspicionConfidence: 1,
};

test("a blatant read catches on easy regardless of the window", () => {
  const { easy } = CONTROL_DIFFICULTY;
  assert.ok(combineSuspicion({ ...quiet, reads_now: 0.9 }, easy) >= easy.threshold);
  assert.ok(
    combineSuspicion({ ...quiet, reads_now: 0.9 }, { ...easy, windowTurns: 50 }) >= easy.threshold,
  );
});

test("staging catches on medium but not on easy", () => {
  const staging = { ...quiet, reads_now: 0.03, stages_indirect: 0.95 };
  const { easy, medium } = CONTROL_DIFFICULTY;
  assert.ok(combineSuspicion(staging, easy) < easy.threshold);
  assert.ok(combineSuspicion(staging, medium) >= medium.threshold);
});

test("low score confidence drops only the score term, not the nouls", () => {
  const { medium } = CONTROL_DIFFICULTY;
  const lowConfidence = {
    ...quiet,
    suspicionScore: MONITOR_SCORE_MAX,
    suspicionConfidence: medium.confidenceFloor - 0.01,
  };
  assert.equal(combineSuspicion(lowConfidence, medium), 0);
  assert.equal(combineSuspicion({ ...lowConfidence, reads_now: 0.9 }, medium), 0.9);
  assert.equal(combineSuspicion({ ...lowConfidence, suspicionConfidence: 1 }, medium), 1);
});

const realFetch = globalThis.fetch;
const realKey = process.env.TYPESAFE_API_KEY;
afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = realKey;
});
const questions = { k: { type: "noul", instructions: "i" } } as const;

test("evaluate sends a v1 request and returns answers and input tokens", async () => {
  process.env.TYPESAFE_API_KEY = "test-key";
  let seen = { url: "", init: {} as RequestInit };
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return Response.json({
      model: TYPESAFE_MODEL,
      answers: { k: { type: "noul", noul: 0.4 } },
      usage: { input_tokens: 123, output_tokens: 5 },
    });
  }) as typeof fetch;
  const result = await evaluate({ a: 1 }, questions);
  assert.deepEqual(result, { answers: { k: { type: "noul", noul: 0.4 } }, inputTokens: 123 });
  assert.equal(seen.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal((seen.init.headers as Record<string, string>).Authorization, "Bearer test-key");
  assert.deepEqual(JSON.parse(seen.init.body as string), {
    model: TYPESAFE_MODEL,
    state: { a: 1 },
    questions,
  });
});

test("evaluate fails clearly without a key, on HTTP errors, on oversized docs, and on a missing answer", async () => {
  delete process.env.TYPESAFE_API_KEY;
  globalThis.fetch = (async () => assert.fail("must not call without a key")) as typeof fetch;
  await assert.rejects(evaluate({}, questions), /TYPESAFE_API_KEY/);
  process.env.TYPESAFE_API_KEY = "test-key";
  globalThis.fetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;
  await assert.rejects(evaluate({}, questions), /status 500/);
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ detail: { error_type: "max_tokens_exceeded" } }), {
      status: 400,
    })) as typeof fetch;
  await assert.rejects(evaluate({}, questions), TypesafeDocumentTooLargeError);
  globalThis.fetch = (async () =>
    Response.json({ answers: {}, usage: { input_tokens: 1 } })) as typeof fetch;
  await assert.rejects(evaluate({}, questions), /omitted the answer/);
});
