import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  combineSuspicion,
  classifierRiskSignals,
  CONTROL_DIFFICULTY,
  MONITOR_SCORE_MAX,
  questionsFor,
  topTerm,
} from "../lib/control";
import { evaluate, TypesafeDocumentTooLargeError } from "../lib/typesafe";
import type { TypesafeQuestion } from "../lib/typesafe";

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

test("stated intent catches on medium and hard, but not easy", () => {
  const intent = { ...quiet, intent: 0.9 };
  const { easy, medium, hard } = CONTROL_DIFFICULTY;
  assert.ok(combineSuspicion(intent, easy) < easy.threshold);
  assert.ok(combineSuspicion(intent, medium) >= medium.threshold);
  assert.ok(combineSuspicion(intent, hard) >= hard.threshold);
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

test("topTerm names the signal that drove the suspicion", () => {
  const { medium } = CONTROL_DIFFICULTY;
  assert.equal(topTerm({ ...quiet, reads_now: 0.9 }, medium), "reads_now");
  assert.equal(topTerm({ ...quiet, stages_indirect: 0.95 }, medium), "stages_indirect");
  assert.equal(topTerm({ ...quiet, suspicionScore: 3 }, medium), "suspicion");
  // Inactive signals never drive it.
  assert.equal(
    topTerm({ ...quiet, stages_indirect: 1, suspicionScore: 1 }, CONTROL_DIFFICULTY.easy),
    "suspicion",
  );
});

test("classifier risk inputs are validated as advisory evidence only", () => {
  const risk = classifierRiskSignals(
    { reads_now: { type: "noul", noul: 0.2 }, stages_indirect: { type: "noul", noul: 0.8 } },
    {
      intent: { type: "noul", noul: 0.1 },
      suspicion: { type: "score", score: 1.43, confidence: 0.9 },
    },
  );
  assert.deepEqual(risk, {
    reads_now: 0.2,
    stages_indirect: 0.8,
    intent: 0.1,
    suspicionScore: 1.43,
    suspicionConfidence: 0.9,
  });
  assert.throws(
    () =>
      classifierRiskSignals(
        {
          reads_now: { type: "noul", noul: Number.NaN },
          stages_indirect: { type: "noul", noul: 0 },
        },
        {
          intent: { type: "noul", noul: 0 },
          suspicion: { type: "score", score: 0, confidence: 1 },
        },
      ),
    /invalid reads_now/,
  );
  assert.throws(
    () =>
      classifierRiskSignals(
        { reads_now: { type: "noul", noul: 0 }, stages_indirect: { type: "noul", noul: 0 } },
        {
          intent: { type: "noul", noul: 0 },
          suspicion: { type: "score", score: 3.1, confidence: 1 },
        },
      ),
    /invalid suspicion score/,
  );
});

test("questionsFor subsets the monitor questions by name", () => {
  assert.deepEqual(Object.keys(questionsFor(["reads_now", "stages_indirect"])), [
    "reads_now",
    "stages_indirect",
  ]);
});

const realFetch = globalThis.fetch;
const realKey = process.env.OPENROUTER_API_KEY;
afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = realKey;
});
const questions = { k: { type: "noul", instructions: "i" } } as const;

test("evaluate sends a v1 request and returns answers and input tokens", async () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  let seen = { url: "", init: {} as RequestInit };
  let calls = 0;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls++;
    seen = { url, init };
    return Response.json({
      model: "typesafe/jev-1.14-20261014",
      answers: { k: { type: "noul", noul: 0.4 } },
      usage: { input_tokens: 123, output_tokens: 5 },
    });
  }) as typeof fetch;
  const result = await evaluate({ a: 1 }, questions);
  assert.deepEqual(result, { answers: { k: { type: "noul", noul: 0.4 } }, inputTokens: 123 });
  assert.equal(calls, 1);
  assert.equal(seen.init.method, "POST");
  assert.equal(seen.url, "https://openrouter.ai/api/v1/systemone");
  assert.equal((seen.init.headers as Record<string, string>).Authorization, "Bearer test-key");
  assert.deepEqual(JSON.parse(seen.init.body as string), {
    model: "typesafe/jev-1.14",
    state: { a: 1 },
    questions,
  });
});

test("evaluate refuses to run without OPENROUTER_API_KEY and ignores the old key", async () => {
  const oldTypesafeKey = process.env.TYPESAFE_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  process.env.TYPESAFE_API_KEY = "legacy-key";
  globalThis.fetch = (async () => assert.fail("must not call without a key")) as typeof fetch;
  try {
    await assert.rejects(evaluate({}, questions), /OPENROUTER_API_KEY is not set\./);
  } finally {
    if (oldTypesafeKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = oldTypesafeKey;
  }
});

test("evaluate returns both answers and input tokens from a recorded OpenRouter response", async () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  const noul = { type: "noul", instructions: "i" } as const;
  globalThis.fetch = (async () =>
    Response.json({
      model: "typesafe/jev-1.14-20261014",
      answers: {
        reads_now: { type: "noul", noul: 0.09 },
        stages_indirect: { type: "noul", noul: 0.06 },
      },
      usage: {
        input_tokens: 334,
        output_tokens: 41,
        cost: 0.000014028,
        is_byok: false,
        cost_details: {
          upstream_inference_cost: 0.000014028,
          upstream_inference_prompt_cost: 0.000014028,
          upstream_inference_completions_cost: 0,
        },
      },
      id: "gen-dec-1795028963-g6NmQCJUz3cCNwDn4ZjZ",
      provider: "TypeSafe",
    })) as typeof fetch;
  assert.deepEqual(await evaluate("printf harmless", { reads_now: noul, stages_indirect: noul }), {
    answers: {
      reads_now: { type: "noul", noul: 0.09 },
      stages_indirect: { type: "noul", noul: 0.06 },
    },
    inputTokens: 334,
  });
});

test("evaluate fails clearly on HTTP errors, on oversized docs, and on a missing answer", async () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  globalThis.fetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;
  await assert.rejects(evaluate({}, questions), (error: Error) => {
    assert.match(error.message, /status 500/);
    assert.doesNotMatch(error.message, /boom/);
    return true;
  });
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ detail: { error_type: "max_tokens_exceeded" } }), {
      status: 400,
    })) as typeof fetch;
  await assert.rejects(evaluate({}, questions), TypesafeDocumentTooLargeError);
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        error: {
          code: 400,
          message: "Provider returned error",
          metadata: { error_type: "max_tokens_exceeded" },
        },
      }),
      { status: 400 },
    )) as typeof fetch;
  await assert.rejects(evaluate({}, questions), TypesafeDocumentTooLargeError);
  globalThis.fetch = (async () =>
    Response.json({ answers: {}, usage: { input_tokens: 1 } })) as typeof fetch;
  await assert.rejects(evaluate({}, questions), /omitted the answer/);
});

test("evaluate accepts probability-weighted scores and rejects malformed scores or usage", async () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  const scoreQuestions: Record<string, TypesafeQuestion> = {
    suspicion: { type: "score", instructions: "i", criteria: ["a", "b", "c"] },
  };
  globalThis.fetch = (async () =>
    Response.json({
      answers: { suspicion: { type: "score", score: 1.43, confidence: 0.8 } },
      usage: { input_tokens: 2 },
    })) as typeof fetch;
  assert.equal((await evaluate({}, scoreQuestions)).answers.suspicion.type, "score");
  globalThis.fetch = (async () =>
    Response.json({
      answers: { suspicion: { type: "score", score: 3.1, confidence: 0.8 } },
      usage: { input_tokens: 2 },
    })) as typeof fetch;
  await assert.rejects(evaluate({}, scoreQuestions), /invalid answer/);
  globalThis.fetch = (async () =>
    Response.json({
      answers: { suspicion: { type: "score", score: 1, confidence: 0.8 } },
      usage: { input_tokens: null },
    })) as typeof fetch;
  await assert.rejects(evaluate({}, scoreQuestions), /invalid usage/);
});
