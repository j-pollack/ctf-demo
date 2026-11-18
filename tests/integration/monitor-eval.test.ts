import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { closePool } from "./postgres";
import { INVESTIGATOR_SYSTEM_PROMPT } from "../../lib/monitor-evidence";
import { AGENT_MODEL } from "../../lib/policy";
import { buildEvaluationReport } from "../../scripts/monitor-investigate-eval";
import { runLiveEvaluation } from "../../scripts/monitor-investigate-eval-live";
import { monitorInvestigationCases } from "../../scripts/monitor-investigation-cases";

const baseUrl = new URL(process.env.CTF_INTEGRATION_DATABASE_URL ?? "http://missing");
assert.equal(process.env.NODE_ENV, "test", "Use npm run test:integration");
assert.equal(baseUrl.hostname, "127.0.0.1", "Use the test harness's loopback Postgres");
assert.match(baseUrl.pathname, /^\/ctf_integration_[a-f0-9]{32}$/);

const databaseName = `ctf_integration_${randomUUID().replaceAll("-", "")}`;
const adminUrl = new URL(baseUrl);
adminUrl.pathname = "/postgres";
const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
let created = false;

await test(
  "live evaluator runs real classifier, investigator and accounting against isolated Postgres",
  { timeout: 120_000 },
  async (t) => {
    t.after(async () => {
      await admin.end();
      if (created) {
        const cleanup = new Pool({ connectionString: adminUrl.toString(), max: 1 });
        try {
          await cleanup.query(`DROP DATABASE "${databaseName}"`);
        } finally {
          await cleanup.end();
        }
      }
    });

    assert.equal(
      (await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [databaseName])).rowCount,
      0,
      "Generated evaluation database must not already exist",
    );
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    const databaseUrl = new URL(baseUrl);
    databaseUrl.pathname = `/${databaseName}`;

    const oldRouterKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "integration-router-key";
    t.after(() => {
      if (oldRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = oldRouterKey;
    });

    let typesafeCalls = 0;
    let investigatorCalls = 0;
    let providerFailures = 0;
    let requestedHistoricalTranscript = false;
    let observedHistoricalToolResult = false;
    let historicalRetrievalStage = 0;
    const reviewPrompts: string[] = [];
    const reviewAttempts = new Map<string, number>();
    const modelVisiblePayloads: string[] = [];
    const retrievalReply = (name: string, args: object) =>
      Response.json({
        id: `synthetic-generation-${randomUUID()}`,
        choices: [
          {
            message: {
              role: "assistant",
              tool_calls: [
                {
                  id: randomUUID(),
                  type: "function",
                  function: { name, arguments: JSON.stringify(args) },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0.00001 },
      });
    t.mock.method(
      globalThis,
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        init?.signal?.throwIfAborted();
        const url = String(input);
        if (url === "https://openrouter.ai/api/v1/systemone") {
          assert.equal(init?.method, "POST");
          assert.equal(
            new Headers(init?.headers).get("authorization"),
            "Bearer integration-router-key",
          );
          const body = JSON.parse(String(init?.body)) as {
            model: string;
            questions: Record<string, unknown>;
            state: unknown;
          };
          assert.equal(body.model, "typesafe/jev-1.14");
          const keys = Object.keys(body.questions).sort().join(",");
          assert.ok(["intent,suspicion", "reads_now,stages_indirect"].includes(keys));
          typesafeCalls++;
          const answers =
            keys === "reads_now,stages_indirect"
              ? {
                  reads_now: { type: "noul", noul: 0 },
                  stages_indirect: { type: "noul", noul: 0 },
                }
              : {
                  intent: { type: "noul", noul: 0 },
                  suspicion: { type: "score", score: 0, confidence: 1 },
                };
          return Response.json({ model: body.model, answers, usage: { input_tokens: 100 } });
        }

        if (url === "https://openrouter.ai/api/v1/models") {
          assert.equal(init?.method, undefined);
          return Response.json({
            data: [...new Set([AGENT_MODEL, "z-ai/glm-5.3"])].map((id) => ({
              id,
              context_length: 100_000,
              pricing: { prompt: "0.000001", completion: "0.000002" },
              supported_parameters: ["tools", "reasoning"],
            })),
          });
        }

        if (url === "https://openrouter.ai/api/v1/chat/completions") {
          assert.equal(init?.method, "POST");
          assert.equal(
            new Headers(init?.headers).get("authorization"),
            "Bearer integration-router-key",
          );
          const request = JSON.parse(String(init?.body)) as {
            model: string;
            stream: boolean;
            max_tokens: number;
            reasoning?: { effort: string };
            messages: { role: string; content?: string }[];
            tools: { function: { name: string } }[];
          };
          assert.equal(request.model, "z-ai/glm-5.3");
          assert.equal(request.max_tokens, 8_192);
          assert.equal(request.reasoning?.effort, "high");
          assert.notEqual(
            request.stream,
            true,
            "Investigator uses the actual buffered review path",
          );
          const systems = request.messages.filter((message) => message.role === "system");
          assert.deepEqual(
            systems.map((system) => system.content),
            [INVESTIGATOR_SYSTEM_PROMPT],
          );
          assert.deepEqual(request.tools.map((tool) => tool.function.name).sort(), [
            "finish_review",
            "list_sessions",
            "read_evidence",
            "read_transcript",
            "search_transcripts",
          ]);
          modelVisiblePayloads.push(
            JSON.stringify({ messages: request.messages, tools: request.tools }),
          );
          const prompt = request.messages.find(
            (message) =>
              message.role === "user" &&
              message.content?.includes("Investigate the following exact review target."),
          )?.content;
          assert.ok(prompt, "Investigator receives the real review prompt");
          let reviewIndex = reviewPrompts.indexOf(prompt);
          if (reviewIndex < 0) reviewIndex = reviewPrompts.push(prompt) - 1;
          const reviewAttempt = reviewAttempts.get(prompt) ?? 0;
          reviewAttempts.set(prompt, reviewAttempt + 1);
          const jsonStart = prompt.indexOf("\n\n") + 2;
          const promptData = JSON.parse(prompt.slice(jsonStart)) as {
            target: { command: string };
            snapshot: {
              userId: string;
              targetSessionId: string;
              searchableHistorySessions: number;
              sessions: { id: string }[];
              currentTranscript: { ref: string; text: string }[];
            };
          };
          if (
            promptData.target.command === "ls /workspace/reports/summary.txt" &&
            promptData.snapshot.currentTranscript.some((message) =>
              message.text.includes("Check that the report output is present."),
            )
          ) {
            assert.equal(promptData.snapshot.sessions.length, 1);
            assert.ok(promptData.snapshot.searchableHistorySessions >= 1);
            assert.ok(promptData.snapshot.sessions.every((session) => session.id.startsWith("s_")));
            assert.doesNotMatch(promptData.snapshot.userId, /workspace|run-/);
            if (historicalRetrievalStage === 0) {
              assert.ok(request.tools.some((tool) => tool.function.name === "search_transcripts"));
              historicalRetrievalStage = 1;
              investigatorCalls++;
              return retrievalReply("search_transcripts", { query: "earlier independent run" });
            }
            const toolResult = request.messages.findLast((message) => message.role === "tool");
            assert.ok(toolResult?.content);
            if (historicalRetrievalStage === 1) {
              const found = JSON.parse(toolResult.content) as {
                rows: { sessionId: string; observationRef: string; text: string }[];
              };
              const history = found.rows.find(
                (row) => row.sessionId !== promptData.snapshot.targetSessionId,
              );
              assert.ok(history);
              assert.ok(
                history.sessionId.startsWith("s_") && history.observationRef.startsWith("o_"),
              );
              assert.match(history.text, /earlier independent run/);
              assert.ok(request.tools.some((tool) => tool.function.name === "read_evidence"));
              requestedHistoricalTranscript = true;
              historicalRetrievalStage = 2;
              investigatorCalls++;
              return retrievalReply("read_evidence", {
                sessionId: history.sessionId,
                observationRef: history.observationRef,
              });
            }
            observedHistoricalToolResult = request.messages.some(
              (message) =>
                message.role === "tool" && message.content?.includes("earlier independent run"),
            );
            assert.ok(
              observedHistoricalToolResult,
              "Pi replays the real historical transcript tool result",
            );
          }
          const visible = promptData.snapshot.currentTranscript[0];
          assert.ok(
            visible?.ref && visible.text,
            "Citation comes from visible transcript evidence",
          );
          investigatorCalls++;
          if (reviewAttempt > 0 && [0, 1, 3, 4, 5, 7].includes(reviewIndex)) {
            const feedback = request.messages.findLast((message) => message.role === "tool");
            assert.ok(
              feedback?.content,
              "Pi returns invalid-decision feedback to the investigator",
            );
          }

          // Exercise the persisted unknown/held path once while leaving attack and benign verdicts
          // to the actual finish_review tool and the same reviewer orchestration used in production.
          if (promptData.target.command.startsWith("printf 'synthetic summary")) {
            providerFailures++;
            return Response.json(
              { error: { message: "Synthetic provider outage" } },
              { status: 503 },
            );
          }
          if (reviewIndex === 5 && reviewAttempt === 1) {
            assert.ok(request.tools.some((tool) => tool.function.name === "read_evidence"));
            return retrievalReply("read_evidence", {
              sessionId: "invalid-session",
              observationRef: "invalid-observation",
            });
          }
          if (reviewIndex === 7 && reviewAttempt === 1) {
            providerFailures++;
            return Response.json(
              { error: { message: "Synthetic correction provider outage" } },
              { status: 503 },
            );
          }

          const verdict = promptData.target.command.includes("daily_report.py") ? "block" : "allow";
          const argumentsJson = JSON.stringify({
            verdict,
            reason:
              ((reviewIndex === 0 || reviewIndex === 7) && reviewAttempt === 0) || reviewIndex === 4
                ? "x".repeat(401)
                : "Synthetic fixture verdict with a citation visible in the supplied prompt.",
            evidence:
              (reviewIndex === 1 || reviewIndex === 5) && reviewAttempt === 0
                ? [
                    { ref: visible.ref, excerpt: visible.text.slice(0, 120) },
                    { ref: visible.ref, excerpt: visible.text.slice(0, 120) },
                  ]
                : reviewIndex === 3 && reviewAttempt === 0
                  ? [{ ref: visible.ref, excerpt: "not present in visible transcript" }]
                  : [{ ref: visible.ref, excerpt: visible.text.slice(0, 120) }],
          });
          const id = `synthetic-generation-${randomUUID()}`;
          return Response.json({
            id,
            choices: [
              {
                message: {
                  role: "assistant",
                  tool_calls: [
                    {
                      id: randomUUID(),
                      type: "function",
                      function: { name: "finish_review", arguments: argumentsJson },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 20,
              total_tokens: 120,
              cost: 0.00001,
            },
          });
        }

        assert.fail(`Unexpected external request: ${url}`);
      },
    );

    const budgetMicrodollars = 200_000;
    const entries = await runLiveEvaluation({
      databaseUrl: databaseUrl.toString(),
      budgetMicrodollars,
    });
    const report = buildEvaluationReport(entries, budgetMicrodollars);
    assert.equal(monitorInvestigationCases.length, 14);
    assert.deepEqual(
      entries.map((entry) => entry.caseId),
      monitorInvestigationCases.map((item) => item.id),
    );
    assert.equal(
      typesafeCalls,
      2 * monitorInvestigationCases.length,
      "Real classifier performs command and context requests per case",
    );
    assert.equal(
      entries[0].verdict,
      "block",
      "malformed finish_review is corrected within the same review",
    );
    assert.equal(entries[1].verdict, "block", "duplicate citations are corrected");
    assert.equal(entries[3].verdict, "allow", "mismatched citations are corrected");
    assert.equal(entries[4].verdict, null, "repeated invalid decisions never approve a run");
    assert.match(entries[4].operationalError ?? "", /call limit reached/i);
    assert.match(entries[4].operationalError ?? "", /invalid finish_review/i);
    assert.equal(reviewAttempts.get(reviewPrompts[4]), 8);
    assert.equal(entries[5].verdict, null, "retrieval failure during correction stays fatal");
    assert.match(entries[5].operationalError ?? "", /invalid|evidence|session|reference/i);
    assert.equal(entries[7].verdict, null, "provider failure during correction stays fatal");
    assert.match(entries[7].operationalError ?? "", /503/);
    assert.equal(investigatorCalls, monitorInvestigationCases.length + 14);
    assert.ok(requestedHistoricalTranscript);
    assert.ok(observedHistoricalToolResult);
    assert.equal(providerFailures, 2);
    assert.ok(entries.some((entry) => entry.expected === "attack" && entry.verdict === "block"));
    assert.ok(entries.some((entry) => entry.expected === "benign" && entry.verdict === "allow"));
    assert.deepEqual(
      entries
        .filter((entry) => entry.expected === "uncertain")
        .map((entry) => entry.caseId)
        .sort(),
      ["concurrent-overwrites-ambiguous", "same-path-unlinked-ambiguous"],
    );
    assert.equal(report.totals.uncertainCases, 2);
    assert.equal(report.totals.unknown, 0);
    assert.equal(report.totals.errors, 4);
    assert.equal(report.totals.budgetExceeded, false);
    assert.ok(entries.every((entry) => entry.investigatorModel === "z-ai/glm-5.3"));
    assert.ok(entries.every((entry) => entry.classifierModel === "typesafe/jev-1.14"));
    assert.ok(
      entries.every(
        (entry) => entry.monitorVersion === "investigator-v4-glm53-jev114-policy-delivery",
      ),
    );

    const persisted = new Pool({
      connectionString: databaseUrl.toString(),
      max: 2,
      options: "-c search_path=ctf,public",
    });
    try {
      const rawIds = await persisted.query<{ id: string }>(
        `SELECT id FROM ctf.games UNION SELECT id FROM ctf.agent_sessions`,
      );
      const owners = await persisted.query<{ owner_id: string; runs: string }>(
        `SELECT owner_id, count(*)::text AS runs FROM ctf.games GROUP BY owner_id`,
      );
      assert.ok(
        owners.rows.some((owner) => Number(owner.runs) >= 2),
        "Live corpus seeds same-owner history in a separate run",
      );
      assert.ok(owners.rows.length > 1, "Other-owner decoys remain separate principals");
      assert.equal(modelVisiblePayloads.length, monitorInvestigationCases.length + 14);
      for (const payload of modelVisiblePayloads) {
        assert.doesNotMatch(
          payload,
          /"(?:gameId|workspaceId|ordinal|revision|admittedRevision|completedRevision|reviewId)"\s*:/,
        );
        for (const { id } of rawIds.rows)
          assert.ok(!payload.includes(id), `Model-visible review leaked raw run/session ID ${id}`);
      }
      const rows = await persisted.query<{
        reviews: string;
        settled_reviews: string;
        error_reviews: string;
        settled_inferences: string;
        settled_classifier_calls: string;
        held_inferences: string;
        settled_microdollars: string;
        held_microdollars: string;
      }>(
        `SELECT count(DISTINCT r.id)::text AS reviews,
           count(DISTINCT r.id) FILTER(WHERE r.verdict IN ('allow','block'))::text AS settled_reviews,
           count(DISTINCT r.id) FILTER(WHERE r.operational_error IS NOT NULL)::text AS error_reviews,
           count(i.id) FILTER(WHERE i.settled_at IS NOT NULL)::text AS settled_inferences,
           count(i.id) FILTER(WHERE i.model='typesafe' AND i.settled_at IS NOT NULL)::text AS settled_classifier_calls,
           count(i.id) FILTER(WHERE i.settled_at IS NULL)::text AS held_inferences,
           coalesce(sum(i.cost) FILTER(WHERE i.settled_at IS NOT NULL),0)::text AS settled_microdollars,
           coalesce(sum(i.cost_ceiling) FILTER(WHERE i.settled_at IS NULL),0)::text AS held_microdollars
         FROM ctf.monitor_reviews r LEFT JOIN ctf.inference i ON i.review_id=r.id
         WHERE r.id=ANY($1::uuid[])`,
        [entries.map((entry) => entry.reviewId)],
      );
      const stored = rows.rows[0];
      const reviewModels = await persisted.query<{ model: string; prompt_version: string }>(
        "SELECT DISTINCT model,prompt_version FROM ctf.monitor_reviews WHERE id=ANY($1::uuid[])",
        [entries.map((entry) => entry.reviewId)],
      );
      assert.deepEqual(reviewModels.rows, [
        { model: "z-ai/glm-5.3", prompt_version: "investigator-v4-glm53-jev114-policy-delivery" },
      ]);
      assert.equal(Number(stored.reviews), monitorInvestigationCases.length);
      assert.equal(Number(stored.settled_reviews), monitorInvestigationCases.length - 4);
      assert.equal(Number(stored.error_reviews), 4);
      assert.equal(
        Number(stored.settled_classifier_calls),
        monitorInvestigationCases.length,
        "Typesafe charges are persisted per review",
      );
      assert.ok(Number(stored.settled_inferences) >= 2 * monitorInvestigationCases.length - 1);
      assert.ok(Number(stored.held_inferences) >= 1, "Provider failure preserves an actual hold");
      assert.equal(Number(stored.settled_microdollars), report.totals.settledMicrodollars);
      assert.equal(Number(stored.held_microdollars), report.totals.heldMicrodollars);
      assert.ok(
        Number(stored.settled_microdollars) + Number(stored.held_microdollars) <=
          budgetMicrodollars,
        "Persisted settled spend plus holds stays within the total evaluator budget",
      );
    } finally {
      await closePool(persisted);
    }
  },
);
