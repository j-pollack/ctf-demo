import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { flagReadCases } from "../../scripts/flag-read-cases";
import { runFlagReadLiveEvaluation } from "../../scripts/flag-read-eval-live";
import { fastMonitorTiming, fastMonitorDelays } from "./monitor-timing";
import { AGENT_MODEL, INVESTIGATOR_MODEL } from "../../lib/policy";
import { flagReadPolicyById } from "../../lib/flag-read-policy";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, prepareBaseline } from "../../scripts/flag-read-baseline-run";
import { buildSchedule, summarizeBaseline } from "../../scripts/flag-read-baseline";
import { syntheticHeldoutCorpus } from "../fixtures/heldout-corpus";
import { baselineSources } from "../../scripts/flag-read-baseline-files";
import { MONITOR_OUTPUT_TOKENS } from "../../lib/monitor-evidence";

const base = new URL(process.env.CTF_INTEGRATION_DATABASE_URL ?? "http://missing");
assert.equal(process.env.NODE_ENV, "test", "Use npm run test:integration");
assert.equal(base.hostname, "127.0.0.1");
assert.match(base.pathname, /^\/ctf_integration_[a-f0-9]{32}$/);

await test(
  "bounded baseline uses real reservations and single-attempt provider calls",
  { timeout: 360_000 },
  async (t) => {
    const modes = [
      "success",
      "rounding",
      "classifier-failure",
      "classifier-usage",
      "missing-usage",
      "timeout",
      "rate-limit",
      "overrun",
      "within-case-overrun",
      "exhaustion",
      "insufficient",
      "callback-failure",
      "wrapper",
      "wrapper-failure",
      "heldout",
      "price-cap",
      "unavailable-provider",
      "slow-success",
      "deadline",
      "classifier-timeout",
    ] as const;
    if (!process.env.CTF_BASELINE_TEST_MODE) {
      for (const mode of modes)
        await t.test(mode, () => {
          const result = spawnSync(
            process.execPath,
            ["--import", "tsx", "--test", fileURLToPath(import.meta.url)],
            {
              env: { ...process.env, NODE_TEST_CONTEXT: undefined, CTF_BASELINE_TEST_MODE: mode },
              encoding: "utf8",
              timeout: 120_000,
            },
          );
          assert.match(
            result.stdout,
            /classifier reserves before HTTP dispatch|tests [1-9]/,
            "child must execute tests",
          );
          assert.equal(result.status, 0, result.stdout + result.stderr);
        });
      return;
    }
    assert.ok(modes.some((mode) => mode === process.env.CTF_BASELINE_TEST_MODE));
    for (const name of modes.filter((mode) => mode === process.env.CTF_BASELINE_TEST_MODE))
      await t.test(name, async (t) => {
        const mode = name;
        const policyId = "v15-unknown";
        const policy = flagReadPolicyById(policyId);
        const fractionalPricing = mode === "price-cap" || mode === "unavailable-provider";
        const longScenario = ["slow-success", "deadline", "classifier-timeout"].includes(mode);
        const database = `ctf_integration_${randomUUID().replaceAll("-", "")}`;
        const adminUrl = new URL(base);
        adminUrl.pathname = "/postgres";
        const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
        await admin.query(`CREATE DATABASE "${database}"`);
        const url = new URL(base);
        url.pathname = `/${database}`;
        const inspection = new Pool({ connectionString: url.toString(), max: 1 });
        t.after(async () => {
          await inspection.end();
          // pg-pool end() can resolve before the backend socket has closed.
          for (let attempt = 0; attempt < 50; attempt++) {
            const { rows } = await admin.query(
              "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1",
              [database],
            );
            if (rows[0].count === 0) break;
            await delay(20);
          }
          await admin.query(`DROP DATABASE "${database}"`);
          await admin.end();
        });
        let classifier = 0,
          investigator = 0;
        const failures: unknown[] = [];
        t.mock.method(
          globalThis,
          "fetch",
          async (input: string | URL | Request, init?: RequestInit) => {
            try {
              const endpoint = String(input);
              if (endpoint === "https://openrouter.ai/api/v1/models")
                return Response.json({
                  data: [...new Set([AGENT_MODEL, INVESTIGATOR_MODEL])].map((id) => ({
                    id,
                    context_length: 200_000,
                    pricing: fractionalPricing
                      ? { prompt: "0.000000084", completion: "0.0000036" }
                      : { prompt: "0.000001", completion: "0.000002" },
                    supported_parameters: ["tools", "reasoning"],
                  })),
                });
              assert.equal(init?.method, "POST");
              const body = JSON.parse(String(init?.body));
              if (endpoint === "https://openrouter.ai/api/v1/systemone") {
                classifier++;
                assert.equal(body.model, "typesafe/jev-1.14");
                assert.deepEqual(Object.keys(body.questions).sort(), ["intent", "suspicion"]);
                const { rows } = await inspection.query(
                  "SELECT * FROM ctf.inference WHERE model='typesafe/jev-1.14' AND settled_at IS NULL",
                );
                assert.equal(
                  rows.length,
                  mode.startsWith("classifier") ? classifier : 1,
                  "classifier reserves before HTTP dispatch",
                );
                assert.ok(Number(rows[0].cost_ceiling) > 0);
                if (longScenario) {
                  const { rows: claims } = await inspection.query(
                    "SELECT extract(epoch FROM (claim_until-updated_at))*1000 AS duration FROM ctf.monitor_jobs WHERE status='reviewing'",
                  );
                  assert.equal(claims.length, 1);
                  assert.equal(Number(claims[0].duration), 120_000);
                }
                if (mode === "classifier-timeout") {
                  assert.ok(init?.signal);
                  await delay(fastMonitorDelays.classifierMs, undefined, { signal: init.signal });
                  assert.fail("classifier must abort before 20 seconds");
                }
                if (mode === "classifier-failure")
                  return new Response("unavailable", { status: 503 });
                return Response.json({
                  answers: {
                    intent: { type: "noul", noul: 0 },
                    suspicion: { type: "score", score: 0, confidence: 1 },
                  },
                  ...(mode === "classifier-usage"
                    ? {}
                    : { usage: { input_tokens: mode === "rounding" ? 2917 : 100 } }),
                });
              }
              assert.equal(
                endpoint,
                "https://openrouter.ai/api/v1/chat/completions",
                "unexpected network request",
              );
              investigator++;
              assert.equal(body.model, INVESTIGATOR_MODEL);
              assert.equal(body.reasoning.effort, "high");
              assert.deepEqual(body.provider, {
                require_parameters: true,
                only: ["digitalocean"],
                allow_fallbacks: false,
                max_price: {
                  prompt: 0.91,
                  completion: 2.86,
                  request: 0,
                },
              });
              assert.equal(body.messages[0].content, policy.systemPrompt);
              assert.doesNotMatch(
                JSON.stringify(body.messages),
                /hiddenSprites|readOccurred|observableSufficiency|observableEquivalenceGroup/,
                "provider receives evidence, not evaluator labels or hidden mappings",
              );
              assert.ok(body.max_tokens > 0 && body.max_tokens <= 8192);
              if (mode === "rate-limit") return new Response("{}", { status: 429 });
              if (mode === "timeout") throw new DOMException("synthetic timeout", "TimeoutError");
              const {
                rows: [reserved],
              } = await inspection.query(
                "SELECT cost_ceiling::int AS cost, token_ceiling FROM ctf.inference WHERE model=$1 AND settled_at IS NULL ORDER BY created_at DESC LIMIT 1",
                [INVESTIGATOR_MODEL],
              );
              assert.ok(reserved.cost > 0, "investigator reserves before dispatch");
              const inputTokens = reserved.token_ceiling - body.max_tokens;
              assert.equal(
                reserved.cost,
                Math.ceil(inputTokens * (body.provider.max_price.prompt / 1e6) * 2 * 1e6) +
                  Math.ceil(body.max_tokens * (body.provider.max_price.completion / 1e6) * 1e6),
                "routing ceilings and the persisted reservation use the same rates",
              );
              if (mode === "slow-success" || mode === "deadline") {
                assert.ok(init?.signal);
                await delay(
                  mode === "slow-success"
                    ? fastMonitorDelays.successMs
                    : fastMonitorDelays.investigatorMs,
                  undefined,
                  {
                    signal: init.signal,
                  },
                );
                if (mode === "deadline") assert.fail("investigation must abort before 95 seconds");
              }
              if (mode === "unavailable-provider")
                return Response.json(
                  {
                    error: {
                      message: "No endpoints found matching your price constraints",
                      code: 404,
                    },
                  },
                  { status: 404 },
                );
              const nextTool =
                mode === "within-case-overrun"
                  ? {
                      name: "query_transcripts",
                      arguments: JSON.stringify({ sql: "SELECT count(*) FROM sessions" }),
                    }
                  : {
                      name: "finish_investigation",
                      arguments: JSON.stringify({
                        flagReadDetected: false,
                        reason: "No evidenced read.",
                        evidence: [],
                      }),
                    };
              return Response.json({
                id: `fake-${randomUUID()}`,
                choices: [
                  {
                    message: {
                      role: "assistant",
                      tool_calls: [{ id: randomUUID(), type: "function", function: nextTool }],
                    },
                    finish_reason: "tool_calls",
                  },
                ],
                ...(mode === "missing-usage"
                  ? {}
                  : {
                      usage: {
                        prompt_tokens: 100,
                        completion_tokens: 30,
                        total_tokens: 130,
                        cost: mode.includes("overrun")
                          ? 1
                          : mode === "exhaustion"
                            ? reserved.cost / 1e6
                            : 0.00001,
                      },
                    }),
              });
            } catch (error) {
              failures.push(error);
              throw error;
            }
          },
        );
        const budget = longScenario
          ? 250_000
          : mode === "insufficient"
            ? 11
            : mode === "within-case-overrun"
              ? 5_000_000
              : mode === "exhaustion"
                ? 30_000
                : 50_000;
        if (mode === "heldout") {
          const corpus = syntheticHeldoutCorpus(readFileSync("evals/flag-read/cases.json", "utf8"));
          const sources = baselineSources();
          const schedule = buildSchedule(corpus, sources, policyId, "test");
          const prepared = prepareBaseline(corpus, schedule, sources, 1_000_000, policyId, "test");
          const entries = await runFlagReadLiveEvaluation(
            { databaseUrl: url.toString(), budgetMicrodollars: 1_000_000 },
            prepared.cases,
            undefined,
            { policyId },
          );
          assert.deepEqual(failures, []);
          assert.equal(entries.length, 40);
          assert.deepEqual(
            entries.map((entry) => entry.caseId),
            schedule.cases.map((item) => item.id),
          );
          assert.ok(
            entries.every(
              (entry) => entry.investigationComplete && entry.caseId.startsWith("test-"),
            ),
          );
          const summary = summarizeBaseline(corpus, entries, schedule);
          assert.equal(summary.scores.strict.incomplete, 0);
          assert.equal(summary.scores.presumption.incomplete, 0);
          assert.equal(summary.scores.strict.labelPositiveDetected, 0);
          assert.equal(summary.scores.presumption.labelPositiveDetected, 0);
          assert.deepEqual(summary.missing, []);
          assert.equal(summary.settledMicrodollars, 40 * 14);
          assert.equal(summary.heldMicrodollars, 0);
          const {
            rows: [accounting],
          } = await inspection.query(
            "SELECT count(*)::int AS requests,sum(cost)::int AS settled,count(*) FILTER(WHERE settled_at IS NULL)::int AS unresolved FROM ctf.inference",
          );
          assert.deepEqual(accounting, {
            requests: 80,
            settled: summary.settledMicrodollars,
            unresolved: 0,
          });
          assert.equal(classifier, 40);
          assert.equal(investigator, 40);
          return;
        }
        const cases = flagReadCases.slice(
          0,
          longScenario ? 1 : mode === "missing-usage" || mode === "timeout" ? 3 : 2,
        );
        if (mode === "wrapper" || mode === "wrapper-failure") {
          const parent = mkdtempSync(join(tmpdir(), "ctf-baseline-"));
          t.after(() => rmSync(parent, { recursive: true, force: true }));
          const output = join(parent, "run");
          // The committed schedules are immutable. Current-source tests use a fresh schedule.
          const schedulePath = join(parent, "current-schedule.json");
          writeFileSync(
            schedulePath,
            JSON.stringify(
              buildSchedule(
                readFileSync("evals/flag-read/cases.json", "utf8"),
                baselineSources(),
                policyId,
              ),
            ),
            { flag: "wx" },
          );
          const argumentsForRun = [
            "--live",
            "--budget-usd",
            "1",
            "--output-dir",
            output,
            "--policy",
            policyId,
            "--schedule",
            schedulePath,
          ];
          if (mode === "wrapper-failure") {
            await inspection.query("CREATE SCHEMA ctf");
            await assert.rejects(
              main(argumentsForRun, {
                ...process.env,
                CTF_INTEGRATION_DATABASE_URL: url.toString(),
              }),
              /already has a ctf schema/,
            );
            const failed = JSON.parse(readFileSync(join(output, "summary.json"), "utf8"));
            assert.equal(failed.status, "failed");
            assert.equal(failed.accountingComplete, false);
            assert.equal(failed.missing.length, 72);
            assert.equal(classifier + investigator, 0);
            return;
          }
          const summary = await main(argumentsForRun, {
            ...process.env,
            CTF_INTEGRATION_DATABASE_URL: url.toString(),
          });
          assert.ok(summary);
          assert.deepEqual(failures, []);
          const { INVESTIGATOR_EFFORT, MONITOR_CALL_LIMIT } =
            await import("../../lib/investigator-driver");
          const schedule = JSON.parse(readFileSync(join(output, "schedule.json"), "utf8"));
          assert.equal(schedule.execution.investigatorCallsPerCase, MONITOR_CALL_LIMIT);
          assert.equal(schedule.execution.investigatorOutputTokensPerCall, MONITOR_OUTPUT_TOKENS);
          assert.equal(schedule.execution.investigatorDeadlineMs, 90_000);
          assert.equal(schedule.policy.effort, INVESTIGATOR_EFFORT);
          assert.equal(schedule.policy.policyId, policyId);
          assert.equal(schedule.policy.promptHash, policy.promptHash);
          const persisted = JSON.parse(readFileSync(join(output, "summary.json"), "utf8"));
          const journal = readFileSync(join(output, "entries.jsonl"), "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          assert.equal(journal.length, 72);
          assert.deepEqual(
            journal.map((entry) => entry.caseId),
            schedule.cases.map((item: { id: string }) => item.id),
          );
          assert.deepEqual(persisted.entries, journal);
          assert.equal(classifier, 72);
          assert.equal(investigator, 72);
          assert.ok(
            journal.every(
              (entry) =>
                entry.investigationComplete &&
                entry.trace &&
                entry.inference.length === 2 &&
                entry.policyId === policyId &&
                entry.promptHash === policy.promptHash &&
                entry.monitorVersion === policy.monitorVersion,
            ),
          );
          const { rows: reviews } = await inspection.query(
            "SELECT DISTINCT prompt_version,prompt_hash FROM ctf.monitor_reviews",
          );
          assert.deepEqual(reviews, [
            { prompt_version: policy.monitorVersion, prompt_hash: policy.promptHash },
          ]);
          assert.equal(persisted.scores.strict.incomplete, 0);
          assert.equal(persisted.scores.presumption.incomplete, 0);
          assert.equal(persisted.status, "completed");
          assert.equal(persisted.settledMicrodollars, 72 * 14);
          await assert.rejects(
            main(argumentsForRun, {
              ...process.env,
              CTF_INTEGRATION_DATABASE_URL: url.toString(),
            }),
            /EEXIST/,
          );
          assert.equal(classifier, 72, "refused overwrite dispatches nothing");
          return;
        }
        if (mode === "callback-failure") {
          await assert.rejects(
            runFlagReadLiveEvaluation(
              { databaseUrl: url.toString(), budgetMicrodollars: budget },
              cases,
              undefined,
              {
                onEntry: () => {
                  throw new Error("synthetic disk full");
                },
              },
            ),
            /synthetic disk full/,
          );
          assert.equal(classifier, 1);
          assert.equal(investigator, 1);
          assert.deepEqual(failures, []);
          return;
        }
        const entries = await runFlagReadLiveEvaluation(
          { databaseUrl: url.toString(), budgetMicrodollars: budget },
          cases,
          undefined,
          {
            policyId,
            timing: longScenario ? fastMonitorTiming : undefined,
          },
        );
        // The fake's deliberate timeout is an external failure, not an assertion failure.
        assert.deepEqual(
          failures.filter(
            (e) =>
              !(
                (e instanceof DOMException && e.name === "TimeoutError") ||
                (longScenario && e instanceof Error && e.name === "AbortError")
              ),
          ),
          [],
        );
        assert.equal(entries.length, cases.length);
        const {
          rows: [totals],
        } = await inspection.query(
          "SELECT coalesce(sum(cost) FILTER(WHERE settled_at IS NOT NULL),0)::int AS settled, coalesce(sum(cost_ceiling) FILTER(WHERE settled_at IS NULL),0)::int AS held FROM ctf.inference",
        );
        assert.equal(
          entries.reduce((s, e) => s + e.settledMicrodollars, 0),
          totals.settled,
        );
        assert.equal(
          entries.reduce((s, e) => s + e.heldMicrodollars, 0),
          totals.held,
        );
        if (longScenario) {
          assert.equal(classifier, 1);
          assert.equal(investigator, mode === "classifier-timeout" ? 0 : 1);
          const entry = entries[0];
          const expectedMs =
            mode === "slow-success"
              ? fastMonitorDelays.successMs
              : mode === "deadline"
                ? fastMonitorTiming.deadlineMs
                : fastMonitorTiming.classifierDeadlineMs;
          assert.ok(entry.latencyMs! >= expectedMs - 50, `elapsed ${entry.latencyMs}ms`);
          assert.ok(entry.latencyMs! < expectedMs + 3_000, `elapsed ${entry.latencyMs}ms`);
          if (mode === "slow-success") {
            assert.equal(entry.investigationComplete, true);
            assert.equal(entry.jobStatus, "caught-up");
            assert.equal(totals.held, 0);
            assert.equal(totals.settled, 14);
          } else {
            assert.equal(entry.investigationComplete, null);
            assert.match(entry.operationalError ?? "", /abort|time|deadline/i);
            assert.equal(entry.jobStatus, "queued");
            assert.equal(totals.settled, mode === "classifier-timeout" ? 0 : 4);
            assert.ok(totals.held > 0);
            const { rows: unresolved } = await inspection.query(
              "SELECT model FROM ctf.inference WHERE settled_at IS NULL",
            );
            assert.deepEqual(unresolved, [
              { model: mode === "classifier-timeout" ? "typesafe/jev-1.14" : INVESTIGATOR_MODEL },
            ]);
          }
        } else if (mode === "success" || mode === "rounding" || mode === "price-cap") {
          assert.equal(classifier, 2);
          assert.equal(investigator, 2);
          assert.ok(entries.every((e) => e.investigationComplete === true));
          assert.equal(
            totals.settled,
            mode === "rounding" ? 266 : 28,
            "classifier rounds 100 × .042 to 4 microdollars per case",
          );
          assert.equal(totals.held, 0);
        } else if (mode === "insufficient") {
          assert.equal(classifier, 0);
          assert.equal(investigator, 0);
          assert.equal(totals.settled + totals.held, 0);
        } else if (mode.includes("overrun")) {
          assert.equal(investigator, 1);
          assert.equal(classifier, 1);
          if (mode === "overrun") assert.ok(totals.settled > budget);
          else
            assert.ok(
              totals.settled < budget,
              "per-call overrun stops even with overall budget available",
            );
          assert.equal(entries[0].accountingOverrun, true);
          assert.equal(entries[1].skipped, true);
        } else if (mode === "exhaustion") {
          assert.equal(classifier, 1);
          assert.equal(investigator, 1);
          assert.equal(entries[1].skipped, true);
          assert.ok(totals.settled <= budget && totals.settled >= budget - 10);
        } else {
          assert.ok(entries.every((e) => e.investigationComplete !== true));
          if (mode.startsWith("classifier")) {
            assert.equal(investigator, 0);
            assert.ok(totals.held > 0);
          }
          if (mode === "rate-limit") {
            assert.equal(investigator, 2, "no HTTP retries");
            assert.equal(totals.held, 0);
          }
          if (mode === "unavailable-provider") {
            assert.equal(classifier, 2);
            assert.equal(investigator, 2, "one capped dispatch per case, no relaxed fallback");
            assert.equal(totals.settled, 8, "only the two classifier charges remain");
            assert.equal(totals.held, 0);
            for (const entry of entries) {
              assert.match(entry.operationalError ?? "", /Inference service returned 404/);
              assert.equal(entry.investigationComplete, null);
            }
            const { rows } = await inspection.query(
              "SELECT cost::int, tokens, settled_at IS NOT NULL AS settled FROM ctf.inference WHERE model=$1",
              [INVESTIGATOR_MODEL],
            );
            assert.deepEqual(rows, [
              { cost: 0, tokens: 0, settled: true },
              { cost: 0, tokens: 0, settled: true },
            ]);
            const { rows: balances } = await inspection.query(
              "SELECT reserved_microdollars::int AS held FROM ctf.games",
            );
            assert.ok(balances.length > 0);
            assert.ok(balances.every((row) => row.held === 0));
            const { rows: daily } = await inspection.query(
              "SELECT reserved::int FROM ctf.daily_spend",
            );
            assert.deepEqual(daily, [{ reserved: 0 }]);
          }
          if (mode === "missing-usage" || mode === "timeout") {
            assert.ok(totals.held > 0);
            // Endpoint rates leave enough for classification but not another investigator.
            // Prove retained holds and actual admission denial under the production prompt.
            assert.equal(investigator, 1);
            assert.ok(entries[0].heldMicrodollars > 0);
            assert.equal(totals.held, entries[0].heldMicrodollars);
            for (const entry of entries.slice(1)) {
              assert.match(entry.operationalError ?? "", /budget/i);
              assert.ok(entry.inference?.every((row) => row.model === "typesafe/jev-1.14"));
            }
          }
          assert.ok(totals.settled + totals.held <= budget);
        }
      });
  },
);
