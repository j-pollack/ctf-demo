import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MONITOR_PROMPT } from "../lib/policy";
import { parseOptions, runEvaluation } from "../scripts/monitor-eval";
import { cases, monitorInput } from "../scripts/monitor-eval-cases";

const model = { id: "test-monitor", reasoning: true, cost: { input: 2, output: 3 } };
const reply = (allow: boolean) => ({
  choices: [
    {
      finish_reason: "stop",
      message: { content: JSON.stringify({ allow, reason: allow ? "" : "Protected read" }) },
    },
  ],
  usage: { cost: 0.001 },
});
async function withProvider(
  answer: (expected: boolean, index: number) => Response | Promise<Response>,
  repeat = 1,
  selectedModel = model,
) {
  const original = globalThis.fetch;
  let index = 0;
  globalThis.fetch = async (input, init) => {
    assert.equal(input, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(init?.method, "POST");
    assert.ok(init?.signal && "aborted" in init.signal);
    const body = JSON.parse(String(init?.body));
    const item = cases[index % cases.length];
    assert.deepEqual(body.messages, [
      { role: "system", content: MONITOR_PROMPT },
      { role: "user", content: JSON.stringify(monitorInput(item)) },
    ]);
    assert.equal(body.model, model.id);
    assert.deepEqual(body.reasoning, selectedModel.reasoning ? { enabled: false } : undefined);
    assert.deepEqual(body.provider, {
      require_parameters: true,
      max_price: { prompt: 2, completion: 3 },
    });
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.equal(body.max_tokens, 2048);
    assert.equal(
      (init!.headers as Record<string, string>).Authorization,
      "Bearer synthetic-eval-key",
    );
    return answer(item.expected, index++);
  };
  try {
    const report = await runEvaluation({
      live: true,
      repeat,
      key: "synthetic-eval-key",
      model: selectedModel,
    });
    assert.equal(index, cases.length * repeat);
    return report;
  } finally {
    globalThis.fetch = original;
  }
}

test("balanced cases cover legitimate and protected reads", () => {
  assert.ok(cases.filter((item) => item.expected).length >= 8);
  assert.ok(cases.filter((item) => !item.expected).length >= 8);
  assert.equal(new Set(cases.map((item) => item.id)).size, cases.length);
  for (const item of cases) {
    const input = monitorInput(item);
    assert.equal(input.proposedToolCall.arguments.command, item.command);
    assert.equal(input.transcript.at(-1)?.role, "assistant");
    assert.equal(JSON.stringify(input).includes('"expected"'), false);
  }
  assert.equal(
    monitorInput(cases.find((item) => item.id === "after-block")!).transcript[3].role,
    "toolResult",
  );
});

test("dry run has no network, no scores; live requires a dedicated key", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("unexpected network");
  };
  try {
    const report = await runEvaluation();
    assert.equal(report.evaluated, false);
    assert.equal(report.results.length, cases.length);
    assert.ok(
      report.results.every((result) => result.status === "unrun" && result.actual === null),
    );
    assert.equal(report.summary.allow.rate, null);
    assert.equal(report.reportedCost, null);
    await assert.rejects(runEvaluation({ live: true }), /EVAL_OPENROUTER_API_KEY/);
    assert.deepEqual(parseOptions(["--live", "--repeat", "5"]), { live: true, repeat: 5 });
    for (const args of [["--repeat", "0"], ["--repeat", "6"], ["--repeat", "1.5"], ["--unknown"]])
      assert.throws(() => parseOptions(args));
  } finally {
    globalThis.fetch = original;
  }
});

test("correct decisions pass; all-allow and all-block expose both error classes", async () => {
  const correct = await withProvider((expected) => Response.json(reply(expected)));
  assert.equal(correct.summary.allow.rate, 1);
  assert.equal(correct.summary.block.rate, 1);
  assert.ok(Math.abs(correct.reportedCost! - cases.length * 0.001) < 1e-10);
  const noReasoning = await withProvider((expected) => Response.json(reply(expected)), 1, {
    ...model,
    reasoning: false,
  });
  assert.equal(noReasoning.summary.block.rate, 1);
  const allAllow = await withProvider(() => Response.json(reply(true)));
  assert.equal(allAllow.summary.falseAllows, cases.filter((item) => !item.expected).length);
  assert.equal(allAllow.summary.block.rate, 0);
  const allBlock = await withProvider(() => Response.json(reply(false)));
  assert.equal(allBlock.summary.falseBlocks, cases.filter((item) => item.expected).length);
  assert.equal(allBlock.summary.allow.rate, 0);
  assert.equal(
    allBlock.results.find((result) => result.id === "after-block")?.status,
    "false_block",
  );
});

test("invalid, truncated, missing, HTTP and timeout replies cannot pass or retry", async () => {
  const bad = [
    Response.json({ choices: [{ finish_reason: "stop", message: { content: "not JSON" } }] }),
    Response.json({
      choices: [
        { finish_reason: "stop", message: { content: '{"allow":false,"reason":"x","extra":1}' } },
      ],
    }),
    Response.json({
      choices: [
        {
          finish_reason: "stop",
          message: { content: JSON.stringify({ allow: false, reason: "x".repeat(201) }) },
        },
      ],
    }),
    Response.json({
      choices: [
        {
          finish_reason: "length",
          message: { content: JSON.stringify({ allow: false, reason: "x" }) },
        },
      ],
    }),
    Response.json({ choices: [{ finish_reason: "stop", message: {} }] }),
    new Response("rate limited", { status: 429 }),
    Response.json({ error: { message: "do not expose provider body" }, ...reply(true) }),
    new Response("{secret provider text", { status: 200 }),
  ];
  const report = await withProvider((_expected, index) => {
    if (index === 8) throw new DOMException("Timed out", "TimeoutError");
    if (index === 9) throw new DOMException("Aborted", "AbortError");
    return bad[index] ?? Response.json(reply(true));
  }, 2);
  assert.equal(report.results.length, cases.length * 2);
  assert.equal(report.summary.formatErrors, 6);
  assert.equal(report.summary.serviceErrors, 4);
  assert.equal(report.summary.allow.total + report.summary.block.total, cases.length * 2);
  assert.equal(report.reportedCost, null);
  assert.ok(report.results.slice(0, 10).every((result) => result.status !== "pass"));
  assert.ok(
    report.results.slice(0, 10).every((result) => !result.reason?.includes("provider body")),
  );
  assert.equal(report.results.at(-1)?.repetition, 2);
});

test("CLI exits 0 dry, 2 for bad setup, 1 for wrong live decisions", () => {
  const cwd = process.cwd();
  const env = {
    NODE_ENV: "test" as const,
    PATH: process.env.PATH ?? "",
    EVAL_OPENROUTER_API_KEY: "synthetic-eval-key",
  };
  const call = (args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", "scripts/monitor-eval.ts", ...args], {
      cwd,
      env,
      encoding: "utf8",
    });
  const dry = call([]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(JSON.parse(dry.stdout).evaluated, false);
  assert.equal(call(["--repeat", "0"]).status, 2);
  const missing = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/monitor-eval.ts", "--live"],
    { cwd, env: { NODE_ENV: env.NODE_ENV, PATH: env.PATH }, encoding: "utf8" },
  );
  assert.equal(missing.status, 2);
  const dir = mkdtempSync(join(tmpdir(), "monitor-eval-test-"));
  try {
    const preload = join(dir, "fake-provider.mjs");
    writeFileSync(
      preload,
      `globalThis.fetch = async (url) => {
      if (url === "https://openrouter.ai/api/v1/models") return Response.json({data:[{id:"test-monitor",context_length:100000,pricing:{prompt:"0.000001",completion:"0.000002",request:"0"},supported_parameters:["response_format"]}]});
      if (url === "https://openrouter.ai/api/v1/chat/completions") return Response.json({choices:[{finish_reason:"stop",message:{content:'{"allow":true,"reason":""}'}}]});
      throw new Error("unexpected URL");
    };`,
    );
    const live = spawnSync(
      process.execPath,
      ["--import", preload, "--import", "tsx", "scripts/monitor-eval.ts", "--live"],
      { cwd, env: { ...env, MONITOR_MODEL: "test-monitor" }, encoding: "utf8" },
    );
    assert.equal(live.status, 1, live.stderr);
    assert.equal(
      JSON.parse(live.stdout).summary.falseAllows,
      cases.filter((item) => !item.expected).length,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
