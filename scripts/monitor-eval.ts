import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MONITOR_MODEL,
  MONITOR_PROMPT,
  MONITOR_REASONING_REQUIRED,
  MONITOR_VERSION,
  parseDecision,
} from "../lib/policy";
import { allowCategories, cases, monitorInput, type Category } from "./monitor-eval-cases";

type Model = { id: string; reasoning: boolean; cost: { input: number; output: number } };
type Options = {
  live?: boolean;
  repeat?: number;
  key?: string;
  modelId?: string;
  model?: Model;
  reasoningRequired?: boolean;
  retries?: number;
  retryDelayMs?: number;
};
type Usage = { input: number; output: number } | null;

// Requests in flight per model; models also run concurrently. The key has no request cap,
// but shared upstream provider pools 429 (no retry-after), so the CLI retries 429s with
// jittered exponential backoff.
const CONCURRENCY = 4;
// Every model the eval scores; MONITOR_MODEL is the production setting, not the eval set.
export const EVAL_MODELS = [
  "qwen/qwen3.8-flash",
  "openai/gpt-6-luna",
  "google/gemini-3.8-flash",
  "deepseek/deepseek-v4.1-flash",
  "z-ai/glm-5.3-flash",
  "mistralai/mistral-small-2603",
  "anthropic/claude-sonnet-5.5",
];
type Status = "unrun" | "pass" | "false_allow" | "false_block" | "format_error" | "service_error";

export function parseOptions(args: string[]) {
  let live = false;
  let repeat = 1;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--live" && !live) live = true;
    else if (args[i] === "--repeat" && i + 1 < args.length && /^[1-5]$/.test(args[i + 1]))
      repeat = Number(args[++i]);
    else throw new Error(`Invalid option: ${args[i]}. Use --live and optional --repeat 1..5.`);
  }
  return { live, repeat };
}

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export async function runEvaluation({
  live = false,
  repeat = 1,
  key,
  modelId = MONITOR_MODEL,
  model,
  reasoningRequired = false,
  retries = 0,
  retryDelayMs = 1000,
}: Options = {}) {
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 5)
    throw new Error("repeat must be an integer from 1 to 5");
  if (live && !key?.trim()) throw new Error("--live requires OPENROUTER_API_KEY");
  if (live && !model) {
    const { getModel } = await import("../lib/inference");
    model = await getModel(modelId, "monitor");
  }
  const results: {
    id: string;
    category: Category;
    repetition: number;
    expected: boolean;
    actual: boolean | null;
    status: Status;
    reason: string | null;
    cost: number | null;
    servedModel: string | null;
    usage: Usage;
    reasoning: string | null;
    retries: number;
  }[] = [];
  const jobs = Array.from({ length: repeat * cases.length }, (_, index) => ({
    index,
    run: Math.floor(index / cases.length),
    item: cases[index % cases.length],
  }));
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const { index, run, item } = jobs[next++];
      let actual: boolean | null = null;
      let reason: string | null = null;
      let cost: number | null = null;
      let servedModel: string | null = null;
      let usage: Usage = null;
      let reasoning: string | null = null;
      let attempts = 0;
      let status: Status = "unrun";
      if (live) {
        try {
          let response: Response;
          // Unlike the app, no max_price: the cheapest catalog endpoint often lacks response_format.
          while (true) {
            response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
              method: "POST",
              headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                model: model!.id,
                messages: [
                  { role: "system", content: MONITOR_PROMPT },
                  { role: "user", content: JSON.stringify(monitorInput(item)) },
                ],
                ...(model!.reasoning
                  ? {
                      reasoning: reasoningRequired
                        ? { effort: "low", exclude: false }
                        : { enabled: false },
                    }
                  : {}),
                provider: { require_parameters: true },
                response_format: { type: "json_object" },
                max_tokens: reasoningRequired ? 8192 : 2048,
              }),
              signal: AbortSignal.timeout(reasoningRequired ? 60000 : 30000),
            });
            if (response.status !== 429 || attempts >= retries) break;
            await new Promise((done) =>
              setTimeout(done, retryDelayMs * 2 ** attempts++ * (1 + Math.random())),
            );
          }
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const body: unknown = await response.json();
          const obj = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
          if (obj.error) throw new Error("Provider response contained error");
          const raw =
            obj.usage && typeof obj.usage === "object"
              ? (obj.usage as Record<string, unknown>)
              : {};
          cost =
            typeof raw.cost === "number" && Number.isFinite(raw.cost) && raw.cost >= 0
              ? raw.cost
              : null;
          servedModel = typeof obj.model === "string" ? obj.model : null;
          usage =
            typeof raw.prompt_tokens === "number" && typeof raw.completion_tokens === "number"
              ? { input: raw.prompt_tokens, output: raw.completion_tokens }
              : null;
          const choice = Array.isArray(obj.choices) ? obj.choices[0] : null;
          const text = choice?.message?.content;
          reasoning =
            typeof choice?.message?.reasoning === "string" && choice.message.reasoning
              ? choice.message.reasoning
              : null;
          if (choice?.finish_reason !== "stop" || typeof text !== "string") {
            status = "format_error";
            reason = "Missing or truncated completion";
          } else {
            try {
              const decision = parseDecision(text);
              if (decision.reason.length > 200) throw new Error("Reason exceeds 200 characters");
              actual = decision.allow;
              reason = decision.reason;
              status = actual === item.expected ? "pass" : actual ? "false_allow" : "false_block";
            } catch {
              status = "format_error";
              reason = "Invalid monitor decision";
            }
          }
        } catch (error) {
          status = error instanceof SyntaxError ? "format_error" : "service_error";
          reason =
            status === "format_error"
              ? "Invalid provider JSON"
              : error instanceof DOMException && error.name === "TimeoutError"
                ? "Request timed out"
                : error instanceof Error && /^HTTP \d+$/.test(error.message)
                  ? error.message
                  : "Provider request failed";
        }
      }
      results[index] = {
        id: item.id,
        category: item.category,
        repetition: run + 1,
        expected: item.expected,
        actual,
        status,
        reason,
        cost,
        servedModel,
        usage,
        reasoning,
        retries: attempts,
      };
    }
  };
  await Promise.all(Array.from({ length: live ? CONCURRENCY : 1 }, worker));
  const classSummary = (expected: boolean) => {
    const group = results.filter((result) => result.expected === expected);
    const passes = group.filter((result) => result.status === "pass").length;
    return { total: group.length, passes, rate: live ? passes / group.length : null };
  };
  const count = (status: Status) => results.filter((result) => result.status === status).length;
  const allowCategorySummary = Object.fromEntries(
    allowCategories.map((category) => {
      const group = results.filter((result) => result.category === category);
      const falseBlocks = group.filter((result) => result.status === "false_block").length;
      return [
        category,
        {
          total: group.length,
          passes: group.filter((result) => result.status === "pass").length,
          falseBlocks,
          formatErrors: group.filter((result) => result.status === "format_error").length,
          serviceErrors: group.filter((result) => result.status === "service_error").length,
          falseBlockRate: live ? falseBlocks / group.length : null,
        },
      ];
    }),
  );
  return {
    timestamp: new Date().toISOString(),
    mode: live ? "live" : "dry-run",
    evaluated: live,
    model: model?.id ?? modelId,
    // Where this request differs from the app's monitor request (lib/inference.ts).
    divergence: ["no max_price cap"],
    monitorVersion: MONITOR_VERSION,
    promptHash: hash(MONITOR_PROMPT),
    suiteHash: hash(
      cases.map((item) => ({
        expected: item.expected,
        category: item.category,
        input: monitorInput(item),
      })),
    ),
    repetitions: repeat,
    summary: {
      allow: {
        ...classSummary(true),
        falseBlockRate: live
          ? count("false_block") / results.filter((result) => result.expected).length
          : null,
      },
      block: classSummary(false),
      allowCategories: allowCategorySummary,
      falseAllows: count("false_allow"),
      falseBlocks: count("false_block"),
      formatErrors: count("format_error"),
      serviceErrors: count("service_error"),
    },
    reportedCost:
      live && results.every((result) => result.cost !== null)
        ? results.reduce((sum, result) => sum + result.cost!, 0)
        : null,
    results,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const options = parseOptions(process.argv.slice(2));
    const key = process.env.OPENROUTER_API_KEY;
    const runs = await Promise.all(
      EVAL_MODELS.map((modelId) =>
        runEvaluation({
          ...options,
          key,
          modelId,
          reasoningRequired: MONITOR_REASONING_REQUIRED.has(modelId),
          retries: 6,
        }),
      ),
    );
    console.log(JSON.stringify({ runs }, null, 2));
    if (options.live && runs.some((run) => run.results.some((result) => result.status !== "pass")))
      process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
