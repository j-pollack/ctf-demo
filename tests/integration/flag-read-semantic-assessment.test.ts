import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { inputCeiling } from "../../lib/policy";
import { MONITOR_TOKEN_MICRODOLLARS } from "../../lib/control";
import { TYPESAFE_MODEL } from "../../lib/typesafe";
import {
  runSemanticAssessment,
  SEMANTIC_ASSESSMENT_QUESTIONS,
  type SemanticAssessmentProgress,
} from "../../scripts/flag-read-semantic-assessment";
import { semanticControls } from "../../scripts/flag-read-semantic-controls";

const state = semanticControls[0].state;
const input = (id: string) => ({ id, state });
const ceiling = Math.ceil(
  inputCeiling({ model: TYPESAFE_MODEL, state, questions: SEMANTIC_ASSESSMENT_QUESTIONS }) *
    MONITOR_TOKEN_MICRODOLLARS,
);

function withKey(t: TestContext) {
  const previous = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = "synthetic-semantic-key";
  t.after(() => {
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous;
  });
}

test("semantic assessor sends the whitelist through real Typesafe transport and applies both score boundaries", async (t) => {
  withKey(t);
  const scores = [
    [0.5, 0.5],
    [0.49, 0.9],
    [0.9, 0.49],
  ];
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), "https://api.typesafe.ai/v1/systemone");
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-semantic-key");
    assert.ok(init?.signal);
    const body = String(init?.body);
    assert.ok(Buffer.byteLength(body, "utf8") <= 48 * 1024);
    const request = JSON.parse(body);
    assert.deepEqual(Object.keys(request).sort(), ["model", "questions", "state"]);
    assert.equal(request.model, "jev-1.14.0");
    assert.deepEqual(request.questions, SEMANTIC_ASSESSMENT_QUESTIONS);
    assert.deepEqual(request.state, state);
    assert.deepEqual(Object.keys(request.state).sort(), ["chain", "rows", "targetSessionId"]);
    for (const hidden of [
      "readOccurred",
      "expectedSupport",
      "scenario",
      "semantic-factory-invoked",
    ])
      assert.ok(!body.includes(hidden), hidden);
    const [binding, read] = scores[calls++];
    return Response.json({
      answers: {
        executionBindingEstablished: { type: "noul", noul: binding },
        successfulReadEstablished: { type: "noul", noul: read },
      },
      usage: { input_tokens: 50 },
    });
  });
  const report = await runSemanticAssessment(
    [input("first"), input("second"), input("third")],
    10_000,
  );
  assert.equal(calls, 3);
  assert.deepEqual(
    report.entries.map((entry) => entry.status),
    ["assessed", "assessed", "assessed"],
  );
  assert.deepEqual(
    report.entries.map((entry) => entry.retained),
    [true, false, false],
  );
  assert.deepEqual(
    report.entries.map((entry) => entry.failedConditions),
    [[], ["executionBindingEstablished"], ["successfulReadEstablished"]],
  );
  assert.deepEqual(report.entries[0].scores, {
    executionBindingEstablished: 0.5,
    successfulReadEstablished: 0.5,
  });
  assert.equal(report.settledMicrodollars, 9);
  assert.equal(report.reservedUnknownMicrodollars, 0);
  assert.ok(report.entries.every((entry) => (entry.latencyMs ?? -1) >= 0));
});

test("malformed and missing Typesafe answers or usage remain unassessed with unknown-cost holds", async (t) => {
  withKey(t);
  const responses = [
    {
      answers: { executionBindingEstablished: { type: "noul", noul: 1 } },
      usage: { input_tokens: 50 },
    },
    {
      answers: {
        executionBindingEstablished: { type: "noul", noul: 2 },
        successfulReadEstablished: { type: "noul", noul: 1 },
      },
      usage: { input_tokens: 50 },
    },
    {
      answers: {
        executionBindingEstablished: { type: "noul", noul: 1 },
        successfulReadEstablished: { type: "noul", noul: 1 },
      },
    },
  ];
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    assert.equal(String(url), "https://api.typesafe.ai/v1/systemone");
    return Response.json(responses[calls++]);
  });
  const report = await runSemanticAssessment(
    [input("missing"), input("malformed"), input("usage")],
    10_000,
  );
  assert.equal(calls, 3);
  assert.deepEqual(
    report.entries.map((entry) => entry.status),
    ["error", "error", "error"],
  );
  assert.deepEqual(
    report.entries.map((entry) => entry.retained),
    [undefined, undefined, undefined],
  );
  assert.ok(report.entries.every((entry) => entry.scores === undefined));
  assert.deepEqual(
    report.entries.map((entry) => entry.reason),
    [
      'Typesafe omitted the answer for "successfulReadEstablished".',
      'Typesafe returned an invalid answer for "executionBindingEstablished".',
      "Typesafe returned invalid usage.",
    ],
  );
  assert.equal(report.reservedUnknownMicrodollars, 3 * ceiling);
  assert.equal(report.settledMicrodollars, 0);
});

test("provider errors and timeout redact transport detail and hold unknown usage", async (t) => {
  withKey(t);
  let calls = 0;
  const actualTimeout = AbortSignal.timeout;
  const timeoutBounds: number[] = [];
  t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    timeoutBounds.push(milliseconds);
    return actualTimeout(milliseconds);
  });
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), "https://api.typesafe.ai/v1/systemone");
    assert.ok(init?.signal);
    calls++;
    if (calls === 1) return new Response("SECRET_BODY", { status: 503 });
    if (calls === 2) throw new DOMException("request timed out", "TimeoutError");
    throw new Error("Bearer synthetic-semantic-key SECRET_BODY");
  });
  const report = await runSemanticAssessment(
    [input("status"), input("timeout"), input("transport")],
    10_000,
  );
  assert.equal(calls, 3);
  assert.deepEqual(timeoutBounds, [15_000, 15_000, 15_000]);
  assert.deepEqual(
    report.entries.map((entry) => entry.reason),
    [
      "Typesafe request failed with status 503.",
      "Semantic assessment timed out.",
      "Semantic assessment request failed.",
    ],
  );
  assert.ok(!JSON.stringify(report).includes("SECRET_BODY"));
  assert.ok(!JSON.stringify(report).includes("synthetic-semantic-key"));
  assert.equal(report.reservedUnknownMicrodollars, 3 * ceiling);
});

test("invalid states, request size and budget skip before dispatch; verified overrun stops later calls", async (t) => {
  withKey(t);
  const extraRows = Array.from({ length: 30 }, (_, index) => ({
    ...state.rows[0],
    ref: `msg:extra:${index}`,
    text: "x".repeat(2_000),
  }));
  const oversized = { ...state, rows: [...state.rows, ...extraRows] };
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    assert.equal(String(url), "https://api.typesafe.ai/v1/systemone");
    calls++;
    return Response.json({
      answers: {
        executionBindingEstablished: { type: "noul", noul: 1 },
        successfulReadEstablished: { type: "noul", noul: 1 },
      },
      usage: { input_tokens: 100_000 },
    });
  });
  const report = await runSemanticAssessment(
    [
      { id: "invalid", state: { ...state, readOccurred: true } },
      { id: "oversized", state: oversized },
      input("overrun"),
      input("after"),
    ],
    10_000,
  );
  assert.equal(calls, 1);
  assert.deepEqual(
    report.entries.map((entry) => entry.status),
    ["skipped", "skipped", "error", "skipped"],
  );
  assert.equal(report.entries[0].reason, "invalid semantic state");
  assert.equal(report.entries[1].reason, "request exceeds 48 KiB");
  assert.equal(report.entries[2].usageExceededCeiling, true);
  assert.equal(report.entries[2].retained, undefined);
  assert.equal(report.entries[3].reason, "verified usage exceeded admission ceiling");
  assert.equal(report.settledMicrodollars, 4_200);
  assert.equal(report.reservedUnknownMicrodollars, 0);
  const noBudget = await runSemanticAssessment([input("budget")], ceiling - 1);
  assert.equal(noBudget.entries[0].reason, "semantic assessment budget exhausted");
  assert.equal(calls, 1);
});

test("progress snapshots reserve before HTTP, settle success, and retain provider-error holds", async (t) => {
  withKey(t);
  const snapshots: SemanticAssessmentProgress[] = [];
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    assert.equal(String(url), "https://api.typesafe.ai/v1/systemone");
    calls++;
    const current = snapshots.at(-1)!;
    assert.deepEqual(current.inFlight, {
      id: calls === 1 ? "ok" : "error",
      ceilingMicrodollars: ceiling,
    });
    assert.equal(current.reservedUnknownMicrodollars, ceiling);
    if (calls === 2) return new Response("SECRET_BODY", { status: 503 });
    return Response.json({
      answers: {
        executionBindingEstablished: { type: "noul", noul: 1 },
        successfulReadEstablished: { type: "noul", noul: 1 },
      },
      usage: { input_tokens: 50 },
    });
  });
  const report = await runSemanticAssessment(
    [input("ok"), input("error"), input("held")],
    2 * ceiling,
    (progress) => {
      snapshots.push(structuredClone(progress));
      progress.entries.length = 0;
    },
  );
  assert.equal(calls, 2);
  assert.deepEqual(
    snapshots.map((snapshot) => [
      snapshot.entries.length,
      snapshot.settledMicrodollars,
      snapshot.reservedUnknownMicrodollars,
      snapshot.inFlight?.id ?? null,
    ]),
    [
      [0, 0, 0, null],
      [0, 0, ceiling, "ok"],
      [1, 3, 0, null],
      [1, 3, ceiling, "error"],
      [2, 3, ceiling, null],
      [3, 3, ceiling, null],
    ],
  );
  assert.deepEqual(
    report.entries.map((entry) => entry.status),
    ["assessed", "error", "skipped"],
  );
  assert.equal(report.entries[2].reason, "semantic assessment budget exhausted");
  assert.equal(report.settledMicrodollars, 3);
  assert.equal(report.reservedUnknownMicrodollars, ceiling);
});

test("progress callback errors propagate before dispatch and after settlement", async (t) => {
  withKey(t);
  const beforeError = new Error("journal failed before request");
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({
      answers: {
        executionBindingEstablished: { type: "noul", noul: 1 },
        successfulReadEstablished: { type: "noul", noul: 1 },
      },
      usage: { input_tokens: 50 },
    });
  });
  await assert.rejects(
    runSemanticAssessment([input("first")], 10_000, (progress) => {
      if (progress.inFlight) throw beforeError;
    }),
    (error) => error === beforeError,
  );
  assert.equal(calls, 0);
  const afterError = new Error("journal failed after settlement");
  await assert.rejects(
    runSemanticAssessment([input("first"), input("second")], 10_000, (progress) => {
      if (progress.entries.length === 1 && !progress.inFlight) throw afterError;
    }),
    (error) => error === afterError,
  );
  assert.equal(calls, 1);
});
