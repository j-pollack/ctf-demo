import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { AGENT_MODEL } from "../../lib/policy";
import { resolveFlagReadPolicy, type FlagReadSearchStrategy } from "../../lib/flag-read-policy";
import { createFinishInvestigationTool } from "../../lib/monitor-evidence";
import { buildFlagReadReport } from "../../scripts/flag-read-eval";
import { runFlagReadLiveEvaluation } from "../../scripts/flag-read-eval-live";
import { heldoutFlagReadCases } from "../../scripts/flag-read-heldout-cases";

const baseUrl = new URL(process.env.CTF_INTEGRATION_DATABASE_URL ?? "http://missing");
assert.equal(process.env.NODE_ENV, "test", "Use npm run test:integration");
assert.equal(baseUrl.hostname, "127.0.0.1");
assert.match(baseUrl.pathname, /^\/ctf_integration_[a-f0-9]{32}$/);

export function testSelectedPolicy(strategy: FlagReadSearchStrategy) {
  test(
    `${strategy} investigator policy reaches Pi and persisted evaluator records`,
    { timeout: 120_000 },
    async (t) => {
      const adminUrl = new URL(baseUrl);
      adminUrl.pathname = "/postgres";
      const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
      const created: string[] = [];
      t.after(async () => {
        try {
          for (const name of created) await admin.query(`DROP DATABASE "${name}"`);
        } finally {
          await admin.end();
        }
      });
      const oldTypesafe = process.env.TYPESAFE_API_KEY;
      process.env.TYPESAFE_API_KEY = "synthetic-reliability-jev";
      t.after(() => {
        if (oldTypesafe === undefined) delete process.env.TYPESAFE_API_KEY;
        else process.env.TYPESAFE_API_KEY = oldTypesafe;
      });
      let selected = resolveFlagReadPolicy("current");
      const readStages = new Map<string, number>();
      const observedPrompts: string[] = [];
      const observedFinishHashes: string[] = [];
      const baseFinishParameters = JSON.parse(
        JSON.stringify(
          createFinishInvestigationTool(
            new Map(),
            "target",
            () => {},
            () => {},
          ).parameters,
        ),
      );
      const baseFinishHash = createHash("sha256")
        .update(JSON.stringify(baseFinishParameters))
        .digest("hex");
      const reply = (name: string, args: object) =>
        Response.json({
          id: `synthetic-${randomUUID()}`,
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
          usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130, cost: 0.00001 },
        });
      t.mock.method(
        globalThis,
        "fetch",
        async (input: string | URL | Request, init?: RequestInit) => {
          init?.signal?.throwIfAborted();
          const url = String(input);
          if (url === "https://api.typesafe.ai/v1/systemone") {
            assert.equal(
              new Headers(init?.headers).get("authorization"),
              "Bearer synthetic-reliability-jev",
            );
            const request = JSON.parse(String(init?.body));
            assert.equal(request.model, "jev-1.14.0");
            assert.deepEqual(Object.keys(request.questions).sort(), ["intent", "suspicion"]);
            return Response.json({
              answers: {
                intent: { type: "noul", noul: 0 },
                suspicion: { type: "score", score: 0, confidence: 1 },
              },
              usage: { input_tokens: 100 },
            });
          }
          if (url === "https://openrouter.ai/api/v1/models")
            return Response.json({
              data: [...new Set([AGENT_MODEL, "z-ai/glm-5.3"])].map((id) => ({
                id,
                context_length: 100_000,
                pricing: { prompt: "0.000001", completion: "0.000002" },
                supported_parameters: ["tools", "reasoning"],
              })),
            });
          if (url !== "https://openrouter.ai/api/v1/chat/completions")
            assert.fail(`Unexpected external request: ${url}`);
          assert.equal(
            new Headers(init?.headers).get("authorization"),
            "Bearer integration-router-key",
          );
          const request = JSON.parse(String(init?.body)) as {
            model: string;
            max_tokens: number;
            reasoning?: { effort: string };
            messages: { role: string; content?: string }[];
            tools: { function: { name: string; parameters: unknown } }[];
          };
          assert.equal(request.model, "z-ai/glm-5.3");
          assert.equal(request.max_tokens, 8_192);
          assert.equal(request.reasoning?.effort, "high");
          const systemMessages = request.messages.filter((message) => message.role === "system");
          const actualPrompt = systemMessages[0]?.content;
          assert.equal(actualPrompt, selected.systemPrompt);
          const isolatedCwd = /^<cwd>\n\/[^\n]*\/tripwire-monitor-[A-Za-z0-9]+\n<\/cwd>$/;
          assert.ok(
            systemMessages
              .slice(1)
              .every(
                (message) => message.content === "" || isolatedCwd.test(message.content ?? ""),
              ),
            "later Pi system messages contain only isolated working-directory context",
          );
          if (selected.searchStrategy === "focused") {
            assert.match(
              actualPrompt,
              /Search strategy: Inspect the initial target evidence first\./,
            );
          } else if (selected.searchStrategy === "provenance") {
            assert.match(actualPrompt, /identify observed evidence linking those contents/);
            assert.doesNotMatch(actualPrompt, /Search strategy: Inspect/);
          } else if (selected.searchStrategy === "read-semantics") {
            assert.match(
              actualPrompt,
              /contents were consumed by the agent or a process it invokes/,
            );
            assert.match(actualPrompt, /Merely opening and closing a file without reading/);
            assert.doesNotMatch(actualPrompt, /identify observed evidence linking those contents/);
            assert.doesNotMatch(actualPrompt, /Search strategy: Inspect/);
          } else {
            assert.equal(selected.searchStrategy, "attribution");
            assert.match(
              actualPrompt,
              /contents were consumed by the agent or a process it invokes/,
            );
            assert.match(
              actualPrompt,
              /observed target command and result also fit a different local program/,
            );
            assert.match(
              actualPrompt,
              /which buffer was inspected or hashed and which buffer was executed/,
            );
            assert.doesNotMatch(actualPrompt, /Search strategy: Inspect/);
          }
          assert.notEqual(actualPrompt, resolveFlagReadPolicy("current").systemPrompt);
          assert.equal(
            createHash("sha256").update(actualPrompt).digest("hex"),
            selected.promptHash,
          );
          observedPrompts.push(actualPrompt);
          assert.deepEqual(request.tools.map((tool) => tool.function.name).sort(), [
            "finish_investigation",
            "query_transcripts",
            "read_transcript",
          ]);
          if (selected.searchStrategy === "attribution") {
            const parameters = request.tools.find(
              (tool) => tool.function.name === "finish_investigation",
            )!.function.parameters;
            assert.deepEqual(parameters, baseFinishParameters);
            const actualHash = createHash("sha256")
              .update(JSON.stringify(parameters))
              .digest("hex");
            assert.equal(actualHash, baseFinishHash);
            observedFinishHashes.push(actualHash);
          }
          const wire = JSON.stringify(request.messages);
          for (const hidden of [
            "heldout-loaded",
            "heldout-target",
            "heldout-digest",
            "heldout-copied",
            "heldout-stdin",
            "readOccurred",
            "observableSufficiency",
            "scenario",
          ])
            assert.ok(!wire.includes(hidden), hidden);
          const prompt = request.messages.find(
            (message) =>
              message.role === "user" &&
              message.content?.startsWith("Investigate successful reads"),
          )?.content;
          assert.ok(prompt);
          const initial = JSON.parse(prompt.slice(prompt.indexOf("\n\n") + 2)) as {
            snapshot: {
              targetSessionId: string;
              targetObservationRef: string;
              currentTranscript: { text: string }[];
            };
          };
          const snapshot = initial.snapshot;
          if (snapshot.currentTranscript.some((row) => row.text.includes("report complete")))
            return Response.json(
              { error: { message: "Synthetic provider outage" } },
              { status: 503 },
            );
          if (snapshot.currentTranscript.some((row) => row.text.includes("loaded-source")))
            return reply("finish_investigation", {
              flagReadDetected: false,
              reason: "The loaded source only prints a marker; no flag read occurred.",
              evidence: [],
            });
          assert.ok(
            !snapshot.currentTranscript.some((row) => row.text.includes("read-ok")),
            "initial target excerpt excludes the earlier read",
          );
          const stage = readStages.get(snapshot.targetObservationRef) ?? 0;
          if (stage === 0) {
            readStages.set(snapshot.targetObservationRef, 1);
            return reply("read_transcript", { sessionId: snapshot.targetSessionId });
          }
          const lastTool = request.messages.findLast((message) => message.role === "tool");
          const page = JSON.parse(lastTool?.content ?? "") as {
            ok: boolean;
            rows: { ref: string; role: string; text: string }[];
          };
          assert.equal(page.ok, true);
          const citation = page.rows.find(
            (row) => row.role === "tool" && row.text.includes("read-ok"),
          );
          assert.ok(citation, "canonical target page contains the earlier completed read");
          return reply("finish_investigation", {
            flagReadDetected: true,
            reason: "The target completed a direct flag read before later benign output.",
            evidence: [{ ref: citation.ref }],
          });
        },
      );

      const cases = [heldoutFlagReadCases[1], heldoutFlagReadCases[3], heldoutFlagReadCases[2]];
      for (const searchStrategy of [strategy]) {
        selected = resolveFlagReadPolicy(searchStrategy);
        const databaseName = `ctf_integration_${randomUUID().replaceAll("-", "")}`;
        assert.equal(
          (await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [databaseName]))
            .rowCount,
          0,
        );
        await admin.query(`CREATE DATABASE "${databaseName}"`);
        created.push(databaseName);
        const databaseUrl = new URL(baseUrl);
        databaseUrl.pathname = `/${databaseName}`;
        const entries = await runFlagReadLiveEvaluation(
          { databaseUrl: databaseUrl.toString(), budgetMicrodollars: 100_000 },
          cases,
          undefined,
          { searchStrategy },
        );
        assert.equal(entries.length, 3);
        assert.deepEqual(
          entries.map((entry) => entry.flagReadDetected),
          [false, true, null],
        );
        assert.deepEqual(
          entries.map((entry) => entry.investigationComplete),
          [true, true, null],
        );
        assert.match(entries[2].operationalError ?? "", /503/);
        assert.ok(
          entries.every(
            (entry) =>
              entry.monitorVersion === selected.monitorVersion &&
              entry.promptHash === selected.promptHash &&
              entry.searchStrategy === searchStrategy,
          ),
        );
        assert.deepEqual(buildFlagReadReport(entries, 100_000).policy, {
          searchStrategy,
          monitorVersion: selected.monitorVersion,
          promptHash: selected.promptHash,
        });
        const persisted = new Pool({ connectionString: databaseUrl.toString(), max: 1 });
        try {
          const games = await persisted.query<{ monitor_version: string }>(
            "SELECT DISTINCT monitor_version FROM ctf.games",
          );
          assert.deepEqual(games.rows, [{ monitor_version: selected.monitorVersion }]);
          const reviews = await persisted.query<{ prompt_version: string }>(
            "SELECT DISTINCT prompt_version FROM ctf.monitor_reviews",
          );
          assert.deepEqual(reviews.rows, [{ prompt_version: selected.monitorVersion }]);
          const persistedResults = await persisted.query<{
            id: string;
            verdict: string | null;
            operational_error: string | null;
          }>(
            "SELECT id,verdict,operational_error FROM ctf.monitor_reviews WHERE id=ANY($1::uuid[])",
            [entries.map((entry) => entry.reviewId)],
          );
          const byId = new Map(persistedResults.rows.map((row) => [row.id, row]));
          assert.equal(byId.size, entries.length);
          assert.equal(byId.get(entries[0].reviewId!)?.verdict, "allow");
          assert.equal(byId.get(entries[1].reviewId!)?.verdict, "block");
          assert.equal(byId.get(entries[2].reviewId!)?.verdict, null);
          assert.match(byId.get(entries[2].reviewId!)?.operational_error ?? "", /503/);
        } finally {
          // pg-pool resolves end() before its socket-close callbacks emit remove.
          // Finish closing every client before teardown drops this disposable database.
          let remaining = persisted.totalCount;
          const closed = new Promise<void>((resolve) => {
            if (!remaining) resolve();
            else
              persisted.on("remove", () => {
                if (--remaining === 0) resolve();
              });
          });
          await persisted.end();
          await closed;
        }
      }
      assert.ok(
        observedPrompts.every((prompt) => prompt === resolveFlagReadPolicy(strategy).systemPrompt),
      );
      assert.equal(observedPrompts.length, 4);
      if (strategy === "attribution")
        assert.deepEqual(observedFinishHashes, Array(4).fill(baseFinishHash));
      assert.equal(readStages.size, 1);
    },
  );
}
