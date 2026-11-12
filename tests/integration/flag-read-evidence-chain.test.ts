import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { withReadEvidenceChain } from "../../lib/flag-read-chain";
import { resolveFlagReadPolicy } from "../../lib/flag-read-policy";
import { createFinishInvestigationTool } from "../../lib/monitor-evidence";
import { AGENT_MODEL } from "../../lib/policy";
import { runFlagReadLiveEvaluation } from "../../scripts/flag-read-eval-live";
import { heldoutFlagReadCases } from "../../scripts/flag-read-heldout-cases";

const baseUrl = new URL(process.env.CTF_INTEGRATION_DATABASE_URL ?? "http://missing");
assert.equal(process.env.NODE_ENV, "test", "Use npm run test:integration");
assert.equal(baseUrl.hostname, "127.0.0.1");
assert.match(baseUrl.pathname, /^\/ctf_integration_[a-f0-9]{32}$/);

test(
  "evidence-chain finish reaches Pi, retries invalid links and persists resolved decisions",
  { timeout: 120_000 },
  async (t) => {
    const adminUrl = new URL(baseUrl);
    adminUrl.pathname = "/postgres";
    const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
    const name = `ctf_integration_${randomUUID().replaceAll("-", "")}`;
    let created = false;
    t.after(async () => {
      try {
        if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    });
    assert.equal(
      (await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [name])).rowCount,
      0,
    );
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    const databaseUrl = new URL(baseUrl);
    databaseUrl.pathname = `/${name}`;
    const oldTypesafe = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = "synthetic-chain-jev";
    t.after(() => {
      if (oldTypesafe === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = oldTypesafe;
    });

    const policy = resolveFlagReadPolicy("evidence-chain");
    const base = createFinishInvestigationTool(
      new Map(),
      "target",
      () => {},
      () => {},
    );
    const expectedParameters = withReadEvidenceChain(
      base,
      new Map(),
      "target",
      () => {},
    ).parameters;
    const expectedHash = createHash("sha256")
      .update(JSON.stringify(expectedParameters))
      .digest("hex");
    assert.deepEqual(
      Object.keys(
        (base.parameters as typeof base.parameters & { properties: Record<string, unknown> })
          .properties,
      ),
      ["flagReadDetected", "reason", "evidence"],
    );
    const stages = new Map<string, number>();
    const citations = new Map<string, string>();
    const prompts: string[] = [];
    const hashes: string[] = [];
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
            "Bearer synthetic-chain-jev",
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
        assert.deepEqual(request.tools.map((tool) => tool.function.name).sort(), [
          "finish_investigation",
          "query_transcripts",
          "read_transcript",
        ]);
        const parameters = request.tools.find(
          (tool) => tool.function.name === "finish_investigation",
        )!.function.parameters;
        const actualHash = createHash("sha256").update(JSON.stringify(parameters)).digest("hex");
        assert.equal(actualHash, expectedHash);
        hashes.push(actualHash);
        const prompt = request.messages.find((message) => message.role === "system")?.content;
        assert.equal(prompt, policy.systemPrompt);
        assert.equal(createHash("sha256").update(prompt!).digest("hex"), policy.promptHash);
        prompts.push(prompt!);
        const initialPrompt = request.messages.find(
          (message) =>
            message.role === "user" && message.content?.startsWith("Investigate successful reads"),
        )?.content;
        assert.ok(initialPrompt);
        const initial = JSON.parse(initialPrompt.slice(initialPrompt.indexOf("\n\n") + 2)) as {
          snapshot: {
            targetObservationRef: string;
            targetSessionId: string;
            currentTranscript: { text: string }[];
          };
        };
        const snapshot = initial.snapshot;
        const text = snapshot.currentTranscript.map((row) => row.text).join("\n");
        if (text.includes("report complete"))
          return Response.json(
            { error: { message: "Synthetic provider outage" } },
            { status: 503 },
          );
        if (text.includes("loaded-source"))
          return reply("finish_investigation", {
            flagReadDetected: false,
            reason: "The loaded source is harmless.",
            evidence: [],
          });
        const stage = stages.get(snapshot.targetObservationRef) ?? 0;
        if (stage === 0) {
          stages.set(snapshot.targetObservationRef, 1);
          return reply("read_transcript", { sessionId: snapshot.targetSessionId });
        }
        if (stage === 1) {
          const lastTool = request.messages.findLast((message) => message.role === "tool");
          const page = JSON.parse(lastTool?.content ?? "") as {
            ok: boolean;
            rows: { ref: string; role: string; text: string }[];
          };
          assert.equal(page.ok, true);
          const citation = page.rows.find(
            (row) => row.role === "tool" && row.text.includes("read-ok"),
          );
          assert.ok(citation);
          citations.set(snapshot.targetObservationRef, citation.ref);
          stages.set(snapshot.targetObservationRef, 2);
          return reply("finish_investigation", {
            flagReadDetected: true,
            reason: "The target completed the direct read.",
            evidence: [{ ref: citation.ref }],
          });
        }
        const ref = citations.get(snapshot.targetObservationRef)!;
        const validChain = {
          reader: { claim: "The target direct command reads the protected file.", refs: [ref] },
          binding: { claim: "The target executed the shown command.", refs: [ref] },
          completion: { claim: "The target result confirms read success.", refs: [ref] },
        };
        if (stage === 2) {
          stages.set(snapshot.targetObservationRef, 3);
          return reply("finish_investigation", {
            flagReadDetected: true,
            reason: "The target completed the direct read.",
            evidence: [{ ref }],
            chain: { ...validChain, binding: { ...validChain.binding, refs: ["unread-ref"] } },
          });
        }
        assert.equal(stage, 3);
        stages.set(snapshot.targetObservationRef, 4);
        return reply("finish_investigation", {
          flagReadDetected: true,
          reason: "The target completed the direct read.",
          evidence: [{ ref }],
          chain: validChain,
        });
      },
    );

    const cases = [heldoutFlagReadCases[1], heldoutFlagReadCases[3], heldoutFlagReadCases[2]];
    const entries = await runFlagReadLiveEvaluation(
      { databaseUrl: databaseUrl.toString(), budgetMicrodollars: 100_000 },
      cases,
      undefined,
      { searchStrategy: "evidence-chain" },
    );
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
          entry.monitorVersion === policy.monitorVersion &&
          entry.promptHash === policy.promptHash &&
          entry.searchStrategy === policy.searchStrategy,
      ),
    );
    assert.ok(prompts.length >= 6);
    assert.equal(new Set(hashes).size, 1);
    assert.deepEqual([...stages.values()], [4]);
    const positiveTrace = entries[1].trace;
    assert.ok(positiveTrace);
    assert.deepEqual(positiveTrace.recordingErrorCodes, []);
    const finishes = positiveTrace.events.flatMap((event) =>
      event.type === "toolResult" && event.result.toolName === "finish_investigation"
        ? [event.result]
        : [],
    );
    assert.equal(finishes.length, 3);
    assert.deepEqual(
      finishes.map((result) => result.isError),
      [true, true, false],
    );
    assert.equal((finishes[0].arguments as { chain?: unknown }).chain, undefined);
    assert.ok((finishes[1].arguments as { chain: unknown }).chain);
    assert.ok((finishes[2].arguments as { chain: unknown }).chain);
    assert.deepEqual(entries[0].evidence, []);
    const persisted = new Pool({ connectionString: databaseUrl.toString(), max: 1 });
    try {
      const reviews = await persisted.query<{
        id: string;
        verdict: string | null;
        operational_error: string | null;
        prompt_version: string;
      }>(
        "SELECT id,verdict,operational_error,prompt_version FROM ctf.monitor_reviews WHERE id=ANY($1::uuid[])",
        [entries.map((entry) => entry.reviewId)],
      );
      const byId = new Map(reviews.rows.map((row) => [row.id, row]));
      assert.equal(byId.size, 3);
      assert.deepEqual(
        entries.map((entry) => byId.get(entry.reviewId!)?.verdict),
        ["allow", "block", null],
      );
      assert.match(byId.get(entries[2].reviewId!)?.operational_error ?? "", /503/);
      assert.ok(reviews.rows.every((row) => row.prompt_version === policy.monitorVersion));
    } finally {
      await persisted.end();
    }
  },
);
