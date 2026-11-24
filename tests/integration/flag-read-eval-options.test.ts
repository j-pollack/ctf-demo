import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { AGENT_MODEL } from "../../lib/policy";
import { flagReadPolicyById, type FlagReadPolicyId } from "../../lib/flag-read-policy";
import { buildFlagReadReport, parseEvalArguments, selectCases } from "../../scripts/flag-read-eval";
import { runFlagReadLiveEvaluation } from "../../scripts/flag-read-eval-live";
import { closePool } from "./postgres";
import { streamedCompletion } from "./completion-stream";

const baseUrl = new URL(process.env.CTF_INTEGRATION_DATABASE_URL ?? "http://missing");
assert.equal(process.env.NODE_ENV, "test", "Use npm run test:integration");
assert.equal(baseUrl.hostname, "127.0.0.1");
assert.match(baseUrl.pathname, /^\/ctf_integration_[a-f0-9]{32}$/);

const adminUrl = new URL(baseUrl);
adminUrl.pathname = "/postgres";

type ChatRequest = { messages: { role: string; content?: string }[] };
type Row = {
  role: string;
  toolCallId?: string;
  sentAt?: string | null;
  returnedAt?: string | null;
};

const command = (id: string, timestamp: number) => ({
  role: "assistant",
  content: [{ type: "toolCall", id, name: "sprite_exec", arguments: { command: `run ${id}` } }],
  api: "openai-completions",
  provider: "openrouter",
  model: "synthetic",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "toolUse",
  timestamp,
});
const output = (id: string, timestamp: number) => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "sprite_exec",
  content: [{ type: "text", text: `output ${id}` }],
  isError: false,
  timestamp,
});
const exportedCase = (id: string, extra: Record<string, unknown> = {}, sessions?: unknown[]) => ({
  id,
  kind: "long-attack",
  targetSessionId: `${id}-target`,
  readOccurred: false,
  sessions: sessions ?? [
    {
      id: `${id}-target`,
      ordinal: 1,
      messages: [
        { role: "user", content: "go", timestamp: 1 },
        command("t1", 1_000),
        output("t1", 2_500),
      ],
    },
  ],
  ...extra,
});

// Runs the real evaluator against a fresh database with only OpenRouter faked, and keeps the
// database open for inspection.
async function evaluate(
  t: test.TestContext,
  cases: ReturnType<typeof selectCases>,
  policyId?: FlagReadPolicyId,
) {
  const database = `ctf_integration_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
  await admin.query(`CREATE DATABASE "${database}"`);
  const databaseUrl = new URL(baseUrl);
  databaseUrl.pathname = `/${database}`;
  const requests: { system: string; rows: Row[] }[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://openrouter.ai/api/v1/systemone")
      return Response.json({
        model: JSON.parse(String(init?.body)).model,
        answers: {
          intent: { type: "noul", noul: 0 },
          suspicion: { type: "score", score: 0, confidence: 1 },
        },
        usage: { input_tokens: 100 },
      });
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
    const request = JSON.parse(String(init?.body)) as ChatRequest;
    const prompt = request.messages.find((message) => message.role === "user")!.content!;
    const initial = JSON.parse(prompt.slice(prompt.indexOf("\n\n") + 2)) as {
      snapshot: { currentTranscript: Row[] };
    };
    requests.push({
      system: request.messages[0].content!,
      rows: initial.snapshot.currentTranscript,
    });
    return streamedCompletion(init, {
      id: `synthetic-${randomUUID()}`,
      choices: [
        {
          message: {
            role: "assistant",
            tool_calls: [
              {
                id: randomUUID(),
                type: "function",
                function: {
                  name: "finish_investigation",
                  arguments: JSON.stringify({
                    flagReadDetected: false,
                    reason: "No successful protected-file read was observed.",
                    evidence: [],
                  }),
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130, cost: 0.00001 },
    });
  });
  const entries = await runFlagReadLiveEvaluation(
    { databaseUrl: databaseUrl.toString(), budgetMicrodollars: 500_000 },
    cases,
    undefined,
    { policyId },
  );
  const inspect = new Pool({ connectionString: databaseUrl.toString(), max: 1 });
  t.after(async () => {
    await closePool(inspect);
    await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
    await admin.end();
  });
  return { entries, requests, inspect };
}

const MODES = ["options", "policy-v14", "policy-v15-shared", "policy-v15-unknown"] as const;

// The evaluator keeps one database pool per process, so each mode runs in its own process.
await test("E1: the evaluator's isolation and policy options reach the seeded runs and prompts", async (t) => {
  const mode = process.env.CTF_EVAL_OPTIONS_MODE;
  if (!mode) {
    for (const value of MODES)
      await t.test(value, () => {
        const result = spawnSync(
          process.execPath,
          ["--import", "tsx", "--test", fileURLToPath(import.meta.url)],
          {
            env: { ...process.env, NODE_TEST_CONTEXT: undefined, CTF_EVAL_OPTIONS_MODE: value },
            encoding: "utf8",
            timeout: 120_000,
          },
        );
        assert.match(result.stdout, /tests [1-9]/);
        assert.equal(result.status, 0, result.stdout + result.stderr);
      });
    return;
  }
  assert.ok(MODES.some((value) => value === mode));
  process.env.OPENROUTER_API_KEY = "integration-router-key";
  const folder = mkdtempSync(join(tmpdir(), "ctf-eval-options-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const write = (name: string, value: unknown) => {
    const path = join(folder, name);
    writeFileSync(path, JSON.stringify(value));
    return path;
  };
  const prompts = {
    v14: flagReadPolicyById("v14").systemPrompt,
    shared: flagReadPolicyById("v16-shared").systemPrompt,
    unknown: flagReadPolicyById("v16-unknown").systemPrompt,
  };
  // The runs of the case a review belongs to: its own and any other run of the same owner.
  const runsOf = async (inspect: Pool, reviewId: string) =>
    (
      await inspect.query(
        `SELECT g.status,g.monitor_isolation,g.monitor_version,
           (SELECT count(*)::int FROM ctf.agent_sessions s WHERE s.game_id=g.id) AS sessions,
           g.id=r.game_id AS is_target
         FROM ctf.monitor_reviews r JOIN ctf.games target ON target.id=r.game_id
           JOIN ctf.games g ON g.owner_id=target.owner_id WHERE r.id=$1 ORDER BY is_target DESC`,
        [reviewId],
      )
    ).rows;

  if (mode.startsWith("policy-")) {
    const policy = mode.slice("policy-".length) as FlagReadPolicyId;
    // --policy names the prompt whatever the run's rule: the run here is isolated for every policy.
    const options = parseEvalArguments([
      "--cases",
      write("export-policy.json", [exportedCase("policy@abc")]),
      "--policy",
      policy,
      "--isolated",
    ]);
    const { entries, requests, inspect } = await evaluate(t, selectCases(options), options.policy);
    const expected = flagReadPolicyById(policy);
    assert.equal(requests[0].system, expected.systemPrompt);
    assert.equal(entries[0].policyId, policy);
    assert.equal(entries[0].promptHash, expected.promptHash);
    const { rows } = await inspect.query(
      "SELECT g.monitor_version,g.monitor_isolation,r.prompt_version,r.prompt_hash FROM ctf.games g JOIN ctf.monitor_reviews r ON r.game_id=g.id",
    );
    assert.deepEqual(rows, [
      {
        monitor_version: expected.monitorVersion,
        monitor_isolation: true,
        prompt_version: expected.monitorVersion,
        prompt_hash: expected.promptHash,
      },
    ]);
    return;
  }

  const corpus = JSON.parse(readFileSync("evals/flag-read/cases.json", "utf8"));
  const twoSprites = corpus.find(
    (item: { hiddenSprites: Record<string, string> }) =>
      new Set(Object.values(item.hiddenSprites)).size === 2,
  );
  const withIsolated = (file: string) => parseEvalArguments(["--cases", file, "--isolated"]);
  const cases = [
    ...selectCases(withIsolated(write("corpus.json", [twoSprites]))),
    ...selectCases(
      withIsolated(
        write("mixed.json", [
          exportedCase("alone@abc", { isolated: false }),
          exportedCase("own@abc", { isolated: true }),
          exportedCase("default@abc"),
        ]),
      ),
    ),
    ...selectCases(parseEvalArguments(["--cases", write("open.json", [exportedCase("open@abc")])])),
    ...selectCases(
      parseEvalArguments([
        "--cases",
        write("operations.json", [
          exportedCase("explicit@abc", {}, [
            {
              id: "explicit@abc-target",
              ordinal: 1,
              messages: [command("e1", 1_000), output("e1", 2_000)],
              operations: [
                {
                  toolCallId: "e1",
                  sentAt: "2026-11-20T10:00:00.250Z",
                  returnedAt: "2026-11-20T10:00:01.500Z",
                },
              ],
            },
          ]),
          exportedCase("derived@abc"),
          exportedCase("none@abc", {}, [
            {
              id: "none@abc-target",
              ordinal: 1,
              messages: [command("n1", 1_000), output("n1", 2_000)],
              operations: [],
            },
          ]),
        ]),
      ]),
    ),
  ];
  const { entries, requests, inspect } = await evaluate(t, cases);
  const byId = new Map(
    entries.map((entry, index) => [entry.caseId, { entry, ...requests[index] }]),
  );
  const caseOf = (id: string) => byId.get(id)!;

  // A corpus-format file is a target run plus a second run of the same owner; --isolated sets the
  // rule on the target run only, and the isolated prompt is the one dispatched.
  const corpusCase = caseOf(twoSprites.id);
  const corpusRuns = await runsOf(inspect, corpusCase.entry.reviewId!);
  assert.equal(corpusRuns.length, 2);
  assert.deepEqual(
    corpusRuns.map((run) => [run.status, run.monitor_isolation]),
    [
      ["active", true],
      ["ended", false],
    ],
  );
  assert.equal(corpusRuns[0].sessions + corpusRuns[1].sessions, twoSprites.sessions.length);
  assert.equal(corpusCase.system, prompts.shared);
  assert.equal(corpusCase.entry.policyId, "v16-shared");
  const { rows: reviews } = await inspect.query(
    "SELECT prompt_version,prompt_hash FROM ctf.monitor_reviews WHERE id=$1",
    [corpusCase.entry.reviewId],
  );
  assert.deepEqual(reviews, [
    {
      prompt_version: flagReadPolicyById("v16-shared").monitorVersion,
      prompt_hash: flagReadPolicyById("v16-shared").promptHash,
    },
  ]);

  // A case's own isolated flag wins over --isolated; without either the run is not isolated.
  for (const [id, isolated] of [
    ["alone@abc", false],
    ["own@abc", true],
    ["default@abc", true],
    ["open@abc", false],
  ] as const) {
    const found = caseOf(id);
    assert.equal(found.system, isolated ? prompts.shared : prompts.unknown, id);
    assert.deepEqual(
      (await runsOf(inspect, found.entry.reviewId!)).map((run) => run.monitor_isolation),
      [isolated],
      id,
    );
  }
  const report = buildFlagReadReport(entries, 500_000);
  assert.equal(report.policy, null);
  assert.deepEqual(report.policies.map((policy) => policy.policyId).sort(), [
    "v16-shared",
    "v16-unknown",
  ]);

  // Operations seeded from the file, derived from message times, or empty.
  const times = (id: string) =>
    caseOf(id)
      .rows.filter((row) => row.role === "tool")
      .map((row) => [row.sentAt, row.returnedAt]);
  assert.deepEqual(times("explicit@abc"), [
    ["2026-11-20T10:00:00.250Z", "2026-11-20T10:00:01.500Z"],
  ]);
  assert.deepEqual(times("derived@abc"), [
    ["1970-01-01T00:00:01.000Z", "1970-01-01T00:00:02.500Z"],
  ]);
  assert.deepEqual(times("none@abc"), [[null, null]]);
  const { rows: operations } = await inspect.query(
    "SELECT tool_call_id,status,started_at FROM ctf.sprite_operations WHERE tool_call_id IN ('e1','n1') ORDER BY tool_call_id",
  );
  assert.deepEqual(
    operations.map((row) => [row.tool_call_id, row.status, row.started_at.toISOString()]),
    [["e1", "completed", "2026-11-20T10:00:00.250Z"]],
  );
});
