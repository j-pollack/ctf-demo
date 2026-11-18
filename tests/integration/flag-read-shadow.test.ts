import assert from "node:assert/strict";
import { test } from "node:test";
import { runShadowAssessment } from "../../scripts/flag-read-shadow";
import type { FlagReadEntry } from "../../scripts/flag-read-eval";

const target = "s_0123456789abcdef01234567";
const row = {
  ref: `msg:opaque:${target}:0`,
  sessionId: target,
  role: "tool",
  text: "read-ok\n[exit 0]",
  sha256: "a".repeat(64),
};
const entry: FlagReadEntry = {
  caseId: "HIDDEN_CASE",
  reviewId: "HIDDEN_REVIEW",
  readOccurred: true,
  observableSufficiency: "ambiguous",
  flagReadDetected: true,
  investigationComplete: true,
  investigatorModel: "z-ai/glm-5.3",
  monitorVersion: "investigator-v7-glm53-jev114-canonical-refs-policy-delivery",
  reason: "A target result has a read marker.",
  evidence: [{ ref: row.ref, excerpt: row.text, sha256: row.sha256 }],
  trace: {
    events: [
      {
        sequence: 0,
        type: "initialEvidence",
        evidence: { snapshot: { targetSessionId: target, currentTranscript: [row] } },
      },
      {
        sequence: 1,
        type: "toolResult",
        result: {
          toolName: "finish_investigation",
          toolCallId: "raw-id",
          arguments: {},
          isError: false,
          content: [],
        },
      },
    ],
    omittedEvents: 0,
    omittedBytes: 0,
    recordingErrors: 0,
    recordingErrorCodes: [],
  },
  latencyMs: 1,
  settledMicrodollars: 1,
  heldMicrodollars: 0,
};

test("shadow sends only allowlisted evidence through real Typesafe transport and settles usage", async (t) => {
  const oldKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "synthetic-shadow-key";
  t.after(() => {
    if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = oldKey;
  });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    calls++;
    assert.equal(String(input), "https://openrouter.ai/api/v1/systemone");
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-shadow-key");
    assert.ok(init?.signal);
    const request = JSON.parse(String(init?.body));
    assert.equal(request.model, "typesafe/jev-1.14");
    assert.deepEqual(Object.keys(request.questions).sort(), [
      "contradiction",
      "crossSessionLinkage",
      "successfulRead",
      "targetExecution",
    ]);
    assert.deepEqual(request.state, {
      targetSessionId: target,
      decision: { flagReadDetected: true, reason: entry.reason, evidence: entry.evidence },
      rows: [row],
    });
    assert.ok(Buffer.byteLength(String(init?.body), "utf8") <= 48 * 1024);
    for (const hidden of [
      "HIDDEN_CASE",
      "HIDDEN_REVIEW",
      "readOccurred",
      "observableSufficiency",
      "raw-id",
    ])
      assert.ok(!String(init?.body).includes(hidden), hidden);
    return Response.json({
      answers: Object.fromEntries(
        Object.keys(request.questions).map((key) => [key, { type: "noul", noul: 0.6 }]),
      ),
      usage: { input_tokens: 50 },
    });
  });
  const before = JSON.stringify(entry);
  const report = await runShadowAssessment([entry], 10_000);
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(entry), before);
  assert.equal(report.settledMicrodollars, 3);
  assert.equal(report.reservedUnknownMicrodollars, 0);
  assert.equal(report.entries[0].status, "assessed");
  assert.equal(report.entries[0].inputTokens, 50);
  assert.equal(report.entries[0].answers?.successfulRead.type, "noul");
  assert.ok((report.entries[0].latencyMs ?? -1) >= 0);
});

test("shadow retains unknown-cost failures and blocks later dispatch under the budget", async (t) => {
  const oldKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "synthetic-shadow-key";
  t.after(() => {
    if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = oldKey;
  });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({ error: "outage" }, { status: 503 });
  });
  const first = await runShadowAssessment([entry], 10_000);
  const ceiling = first.reservedUnknownMicrodollars;
  assert.ok(ceiling > 0);
  const report = await runShadowAssessment([entry, entry], ceiling);
  assert.equal(calls, 2);
  assert.equal(report.entries[0].status, "error");
  assert.match(report.entries[0].reason ?? "", /503/);
  assert.equal(report.entries[1].status, "skipped");
  assert.equal(report.entries[1].reason, "shadow budget exhausted");
  assert.equal(report.reservedUnknownMicrodollars, ceiling);
  assert.equal(report.remainingBudgetMicrodollars, 0);
});

test("shadow skips oversized input before dispatch and reports verified ceiling overruns", async (t) => {
  const oldKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "synthetic-shadow-key";
  t.after(() => {
    if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = oldKey;
  });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_input: string | URL | Request, init?: RequestInit) => {
    calls++;
    const request = JSON.parse(String(init?.body));
    return Response.json({
      answers: Object.fromEntries(
        Object.keys(request.questions).map((key) => [key, { type: "noul", noul: 0.4 }]),
      ),
      usage: { input_tokens: 100_000 },
    });
  });
  const oversizedRow = { ...row, text: "x".repeat(50 * 1024) };
  const oversized = {
    ...entry,
    evidence: [{ ref: row.ref, excerpt: oversizedRow.text, sha256: row.sha256 }],
    trace: {
      ...entry.trace!,
      events: [
        {
          sequence: 0,
          type: "initialEvidence" as const,
          evidence: { snapshot: { targetSessionId: target, currentTranscript: [oversizedRow] } },
        },
        entry.trace!.events[1],
      ],
    },
  } satisfies FlagReadEntry;
  const report = await runShadowAssessment([oversized, entry], 1_000);
  assert.equal(calls, 1);
  assert.equal(report.entries[0].reason, "request exceeds 48 KiB");
  assert.equal(report.entries[1].status, "error");
  assert.equal(report.entries[1].reason, "verified usage exceeded admission ceiling");
  assert.equal(report.entries[1].inputTokens, 100_000);
  assert.equal(report.entries[1].answers?.successfulRead.type, "noul");
  assert.equal(report.settledMicrodollars, 4_200);
  assert.equal(report.remainingBudgetMicrodollars, -3_200);
});
