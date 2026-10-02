import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MONITOR_MODEL, MONITOR_PROMPT, MONITOR_VERSION, parseDecision } from "../lib/policy";
import { allowCategories, cases, monitorInput, type Category } from "./monitor-eval-cases";

type Model = { id: string; reasoning: boolean; cost: { input: number; output: number } };
type Options = { live?: boolean; repeat?: number; key?: string; model?: Model };
type Status =
  | "unrun"
  | "pass"
  | "observed"
  | "false_allow"
  | "false_block"
  | "format_error"
  | "service_error";

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

export async function runEvaluation({ live = false, repeat = 1, key, model }: Options = {}) {
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 5)
    throw new Error("repeat must be an integer from 1 to 5");
  if (live && !key?.trim()) throw new Error("--live requires EVAL_OPENROUTER_API_KEY");
  if (live && !model) {
    const { getModel } = await import("../lib/inference");
    model = await getModel(MONITOR_MODEL, "monitor");
  }
  const results: {
    id: string;
    category: Category;
    repetition: number;
    expected: boolean | null;
    actual: boolean | null;
    status: Status;
    reason: string | null;
    cost: number | null;
  }[] = [];
  for (let run = 0; run < repeat; run++)
    for (const item of cases) {
      let actual: boolean | null = null;
      let reason: string | null = null;
      let cost: number | null = null;
      let status: Status = "unrun";
      if (live) {
        try {
          const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              model: model!.id,
              messages: [
                { role: "system", content: MONITOR_PROMPT },
                { role: "user", content: JSON.stringify(monitorInput(item)) },
              ],
              ...(model!.reasoning ? { reasoning: { enabled: false } } : {}),
              provider: {
                require_parameters: true,
                max_price: { prompt: model!.cost.input, completion: model!.cost.output },
              },
              response_format: { type: "json_object" },
              max_tokens: 2048,
            }),
            signal: AbortSignal.timeout(30000),
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const body: unknown = await response.json();
          const obj = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
          if (obj.error) throw new Error("Provider response contained error");
          const usage =
            obj.usage && typeof obj.usage === "object"
              ? (obj.usage as Record<string, unknown>)
              : {};
          cost =
            typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0
              ? usage.cost
              : null;
          const choice = Array.isArray(obj.choices) ? obj.choices[0] : null;
          const text = choice?.message?.content;
          if (choice?.finish_reason !== "stop" || typeof text !== "string") {
            status = "format_error";
            reason = "Missing or truncated completion";
          } else {
            try {
              const decision = parseDecision(text);
              if (decision.reason.length > 200) throw new Error("Reason exceeds 200 characters");
              actual = decision.allow;
              reason = decision.reason;
              status =
                item.expected === null
                  ? "observed"
                  : actual === item.expected
                    ? "pass"
                    : actual
                      ? "false_allow"
                      : "false_block";
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
      results.push({
        id: item.id,
        category: item.category,
        repetition: run + 1,
        expected: item.expected,
        actual,
        status,
        reason,
        cost,
      });
    }
  const classSummary = (expected: boolean) => {
    const group = results.filter((result) => result.expected === expected);
    const passes = group.filter((result) => result.status === "pass").length;
    return { total: group.length, passes, rate: live ? passes / group.length : null };
  };
  const count = (status: Status) => results.filter((result) => result.status === status).length;
  const diagnostics = results.filter((result) => result.expected === null);
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
    model: model?.id ?? MONITOR_MODEL,
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
      diagnostic: {
        total: diagnostics.length,
        observed: count("observed"),
        formatErrors: diagnostics.filter((result) => result.status === "format_error").length,
        serviceErrors: diagnostics.filter((result) => result.status === "service_error").length,
      },
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
    const report = await runEvaluation({ ...options, key: process.env.EVAL_OPENROUTER_API_KEY });
    console.log(JSON.stringify(report, null, 2));
    if (
      options.live &&
      report.results.some((result) => result.status !== "pass" && result.status !== "observed")
    )
      process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
