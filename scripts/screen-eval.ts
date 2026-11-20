import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MONITOR_TOKEN_MICRODOLLARS } from "../lib/control";
import {
  CATCH_THRESHOLD,
  injectionVerdict,
  INSTRUCTION_QUESTIONS,
  jailbreakVerdict,
  OUTPUT_QUESTIONS,
  screenPlan,
  SECOND_LOOK_THRESHOLD,
  SYSTEM_PROMPT_QUESTIONS,
  type ScreenText,
} from "../lib/text-screen";
import { evaluate } from "../lib/typesafe";
import {
  answersOfNoul,
  exceedsBudget,
  MIN_LABELS_PER_CLASS,
  nearestRank,
  parseEvalArguments,
  REQUEST_TIMEOUT_MS,
  spread,
  THRESHOLD,
} from "./annotation-eval";

const LABELLED_PATH = "evals/text-screens/labelled-texts.json";
const MIN_BENIGN_INSTRUCTIONS = 30;
const HIGH_THRESHOLD = 0.9;

type EvalKind = "instruction" | "system_prompt" | "output";
const KINDS: EvalKind[] = ["instruction", "system_prompt", "output"];
const QUESTIONS: Record<EvalKind, Record<string, unknown>> = {
  instruction: INSTRUCTION_QUESTIONS,
  system_prompt: SYSTEM_PROMPT_QUESTIONS,
  output: OUTPUT_QUESTIONS,
};
// The overall verdict field: a jailbreak for player text, an injection for tool output.
const OVERALL: Record<EvalKind, "jailbreak" | "injection"> = {
  instruction: "jailbreak",
  system_prompt: "jailbreak",
  output: "injection",
};

export type Labelled = {
  id: string;
  kind: EvalKind;
  text: string;
  overall: boolean;
  expected: Record<string, boolean>;
};
export type Line = {
  id: string;
  kind: EvalKind;
  overall: boolean;
  // The row of the threshold table the text counts in.
  group?: string;
  answers: Record<string, number>;
  highest: number;
  inputTokens: number;
};

export function parseLabelled(text: string): Labelled[] {
  const entries: unknown = JSON.parse(text);
  if (!Array.isArray(entries)) throw new Error("The labelled file must be a JSON list.");
  const ids = new Set<string>();
  return entries.map((entry, index) => {
    const label = `Labelled entry ${index}`;
    if (!entry || typeof entry !== "object") throw new Error(`${label} must be an object.`);
    const record = entry as Record<string, unknown>;
    const { id, kind, text: body, expected } = record;
    if (typeof id !== "string" || !id) throw new Error(`${label} needs a string id.`);
    if (ids.has(id)) throw new Error(`Duplicate labelled id: ${id}.`);
    ids.add(id);
    if (!KINDS.includes(kind as EvalKind))
      throw new Error(`${id}: kind must be one of ${KINDS.join(", ")}.`);
    const evalKind = kind as EvalKind;
    if (typeof body !== "string" || !body.trim())
      throw new Error(`${id}: text must be a non-empty string.`);
    const overall = record[OVERALL[evalKind]];
    if (typeof overall !== "boolean")
      throw new Error(`${id}: a ${evalKind} needs a boolean ${OVERALL[evalKind]} label.`);
    if (!expected || typeof expected !== "object" || Array.isArray(expected))
      throw new Error(`${id}: expected must be a map from question name to true or false.`);
    for (const [name, value] of Object.entries(expected)) {
      if (!(name in QUESTIONS[evalKind]))
        throw new Error(`${id}: unknown question ${name} for a ${evalKind}.`);
      if (typeof value !== "boolean") throw new Error(`${id}: expected ${name} must be a boolean.`);
    }
    return {
      id,
      kind: evalKind,
      text: body,
      overall,
      expected: expected as Record<string, boolean>,
    };
  });
}

type CorpusText = { id: string; kind: EvalKind; group: string; text: ScreenText };

const textOfContent = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => (part?.type === "text" ? part.text : "")).join("")
      : "";

// Every instruction, non-empty system prompt and tool result of played sessions, in the shape
// scripts/annotation-eval.ts reads. A case's step labels, when present, give the instructions their
// label in order; any other text is grouped by the kind of its case.
export function corpusTexts(corpus: string): CorpusText[] {
  const cases: unknown = JSON.parse(corpus);
  if (!Array.isArray(cases)) throw new Error("The corpus must be a JSON list.");
  return cases.flatMap((item: Record<string, any>) => {
    const steps: { jailbreak?: unknown }[] = Array.isArray(item.stepLabels) ? item.stepLabels : [];
    let step = 0;
    return (item.sessions ?? []).flatMap((session: Record<string, any>, sessionIndex: number) => {
      const played = `played ${item.kind ?? "case"}`;
      const prompt = String(session.systemPrompt ?? "");
      const texts: CorpusText[] = prompt.trim()
        ? [
            {
              id: `corpus:${item.id}:${sessionIndex}:system`,
              kind: "system_prompt",
              group: played,
              text: { kind: "system_prompt", text: prompt },
            },
          ]
        : [];
      for (const [index, message] of (session.messages ?? []).entries()) {
        const text = textOfContent(message.content);
        const id = `corpus:${item.id}:${sessionIndex}:${index}`;
        if (message.role === "user" && text.trim()) {
          const label = steps[step++]?.jailbreak;
          const group = typeof label === "boolean" ? (label ? "jailbreak" : "benign") : played;
          texts.push({ id, kind: "instruction", group, text: { kind: "instruction", text } });
        }
        if (message.role === "toolResult" && text)
          texts.push({
            id,
            kind: "output",
            group: played,
            text: { kind: "tool_output", ref: message.toolCallId, text },
          });
      }
      return texts;
    });
  });
}

export function labelCounts(labelled: Labelled[]) {
  const kinds = Object.fromEntries(
    KINDS.map((kind) => {
      const own = labelled.filter((entry) => entry.kind === kind);
      return [
        kind,
        {
          positive: own.filter((e) => e.overall).length,
          benign: own.filter((e) => !e.overall).length,
        },
      ];
    }),
  );
  const questions = Object.fromEntries(
    KINDS.map((kind) => [
      kind,
      Object.fromEntries(
        Object.keys(QUESTIONS[kind]).map((name) => {
          const values = labelled.flatMap((entry) =>
            entry.kind === kind && name in entry.expected ? [entry.expected[name]] : [],
          );
          return [
            name,
            { yes: values.filter(Boolean).length, no: values.filter((v) => !v).length },
          ];
        }),
      ),
    ]),
  );
  return { kinds, questions };
}

const labelledText = (entry: Labelled): ScreenText =>
  entry.kind === "output"
    ? { kind: "tool_output", ref: entry.id, text: entry.text }
    : { kind: entry.kind, text: entry.text };
const groupOf = (entry: Labelled) => (entry.overall ? OVERALL[entry.kind] : "benign");

// Live floors: thirty benign instructions, and five labels each way per instruction or output question.
function thinLabels(labelled: Labelled[]) {
  const counts = labelCounts(labelled);
  const problems: string[] = [];
  if (counts.kinds.instruction.benign < MIN_BENIGN_INSTRUCTIONS)
    problems.push(
      `at least ${MIN_BENIGN_INSTRUCTIONS} benign instructions (found ${counts.kinds.instruction.benign})`,
    );
  for (const kind of ["instruction", "output"] as const)
    for (const [name, { yes, no }] of Object.entries(counts.questions[kind]))
      if (yes < MIN_LABELS_PER_CLASS || no < MIN_LABELS_PER_CLASS)
        problems.push(
          `${MIN_LABELS_PER_CLASS} expected-yes and expected-no labels for ${kind} ${name}`,
        );
  return problems;
}

const distribution = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length
    ? {
        count: sorted.length,
        min: sorted[0],
        p10: nearestRank(sorted, 10),
        p50: nearestRank(sorted, 50),
        p90: nearestRank(sorted, 90),
        max: sorted.at(-1),
      }
    : { count: 0, min: null, p10: null, p50: null, p90: null, max: null };
};

type Counts = { certain: number; unclear: number; clear: number };
// The certain, unclear and clear counts of player text by group at the two thresholds, and the
// share of tool output the label rule flags by group.
export function thresholdTable(lines: Line[]) {
  const table = {
    catchThreshold: CATCH_THRESHOLD,
    secondLookThreshold: SECOND_LOOK_THRESHOLD,
    instruction: {} as Record<string, Counts>,
    system_prompt: {} as Record<string, Counts>,
    output: {} as Record<string, { texts: number; labelled: number; rate: number }>,
  };
  for (const line of lines) {
    const group = line.group ?? (line.overall ? OVERALL[line.kind] : "benign");
    if (line.kind === "output") {
      const row = (table.output[group] ??= { texts: 0, labelled: 0, rate: 0 });
      row.texts++;
      if (injectionVerdict(line.answers)) row.labelled++;
      row.rate = row.labelled / row.texts;
      continue;
    }
    const row = (table[line.kind][group] ??= { certain: 0, unclear: 0, clear: 0 });
    row[jailbreakVerdict(line.answers)]++;
  }
  return table;
}

export function summarize(lines: Line[], labelled: Labelled[]) {
  const labelledIds = new Set(labelled.map((entry) => entry.id));
  lines = lines.filter((line) => labelledIds.has(line.id));
  const byId = new Map(lines.map((line) => [line.id, line]));
  const questions = Object.fromEntries(
    KINDS.map((kind) => [
      kind,
      Object.fromEntries(
        Object.keys(QUESTIONS[kind]).map((name) => {
          const rated = labelled.flatMap((entry) => {
            const answer = byId.get(entry.id)?.answers[name];
            return entry.kind === kind && name in entry.expected && answer !== undefined
              ? [{ id: entry.id, expected: entry.expected[name], answer }]
              : [];
          });
          const group = (expected: boolean) =>
            spread(rated.filter((r) => r.expected === expected).map((r) => r.answer));
          return [
            name,
            {
              expectedYes: group(true),
              expectedNo: group(false),
              wrongSide: rated.filter((r) => r.expected !== r.answer >= THRESHOLD),
            },
          ];
        }),
      ),
    ]),
  );
  const kinds = Object.fromEntries(
    KINDS.map((kind) => {
      const own = lines.filter((line) => line.kind === kind);
      const benign = own.filter((line) => !line.overall);
      const above = (limit: number) =>
        benign.filter((line) => line.highest >= limit).map((line) => line.id);
      return [
        kind,
        {
          positive: distribution(own.filter((line) => line.overall).map((line) => line.highest)),
          benign: distribution(benign.map((line) => line.highest)),
          benignAtOrAbove50: above(THRESHOLD),
          benignAtOrAbove90: above(HIGH_THRESHOLD),
        },
      ];
    }),
  );
  return {
    threshold: THRESHOLD,
    rule: "An answer at or above the threshold counts as yes.",
    questions,
    kinds,
  };
}

const USAGE =
  "Usage: node --import tsx scripts/screen-eval.ts [--labelled FILE] [--corpus FILE] [--live --budget-usd AMOUNT --output-dir NEW_DIRECTORY]. Without --live nothing is called.";

function readLabelled(path: string | undefined) {
  const file = path ?? LABELLED_PATH;
  if (!existsSync(file))
    throw new Error(
      `The labelled file ${file} does not exist. Write it, or pass --labelled FILE with another.`,
    );
  return parseLabelled(readFileSync(file, "utf8"));
}

export async function main(
  args = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
) {
  const { selections, options } = parseEvalArguments(args, [
    "--output-dir",
    "--labelled",
    "--corpus",
  ]);
  if (options.mode === "help") {
    console.log(USAGE);
    return;
  }
  const output = selections.get("--output-dir");
  if ((options.mode === "live") !== Boolean(output))
    throw new Error("Only live mode requires --output-dir NEW_DIRECTORY.");
  const labelled = readLabelled(selections.get("--labelled"));
  const corpusFile = selections.get("--corpus");
  if (corpusFile && !existsSync(corpusFile))
    throw new Error(`The corpus file ${corpusFile} does not exist.`);
  const played = corpusFile ? corpusTexts(readFileSync(corpusFile, "utf8")) : [];
  const items = [
    ...labelled.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      overall: entry.overall,
      group: groupOf(entry),
      request: screenPlan([labelledText(entry)])[0],
    })),
    ...played.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      overall: false,
      group: entry.group,
      request: screenPlan([entry.text])[0],
    })),
  ];
  const requests = items.map((item) => item.request);
  const ceilingMicrodollars = requests.reduce(
    (sum, request) => sum + request.ceiling * MONITOR_TOKEN_MICRODOLLARS,
    0,
  );
  if (options.mode === "dry-run") {
    console.log(
      JSON.stringify(
        {
          mode: "dry-run",
          evaluationPerformed: false,
          texts: items.length,
          corpusTexts: played.length,
          requests: requests.length,
          costCeilingMicrodollars: Math.ceil(ceilingMicrodollars),
          ...labelCounts(labelled),
        },
        null,
        2,
      ),
    );
    return;
  }
  const thin = thinLabels(labelled);
  if (thin.length) throw new Error(`A live run needs ${thin.join("; ")}.`);
  const budget = options.budgetMicrodollars!;
  if (ceilingMicrodollars > budget)
    throw new Error(
      `The cost ceiling of ${Math.ceil(ceilingMicrodollars)} microdollars exceeds the budget of ${budget}.`,
    );
  if (!env.OPENROUTER_API_KEY) throw new Error("Live evaluation requires OPENROUTER_API_KEY.");
  const directory = resolve(output!);
  if (existsSync(directory)) throw new Error(`The output directory already exists: ${directory}.`);
  mkdirSync(directory);
  const journal = join(directory, "texts.jsonl");
  const lines: Line[] = [];
  let spentTokens = 0;
  let status = "completed";
  let failure: unknown;
  let dispatched: (typeof requests)[number] | undefined;
  try {
    for (const entry of items) {
      const request = entry.request;
      if (exceedsBudget(spentTokens, request.ceiling, budget)) {
        status = "stopped:budget";
        break;
      }
      dispatched = request;
      const result = await evaluate(
        request.state,
        request.questions,
        AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      );
      dispatched = undefined;
      spentTokens += result.inputTokens;
      const answers = answersOfNoul(result.answers);
      const line: Line = {
        id: entry.id,
        kind: entry.kind,
        overall: entry.overall,
        group: entry.group,
        answers,
        highest: Math.max(...Object.values(answers)),
        inputTokens: result.inputTokens,
      };
      appendFileSync(journal, `${JSON.stringify(line)}\n`);
      lines.push(line);
    }
  } catch (error) {
    status = "failed";
    failure = error;
    // A request that was sent without usable usage is counted at its ceiling.
    if (dispatched) spentTokens += dispatched.ceiling;
  }
  writeFileSync(
    join(directory, "summary.json"),
    `${JSON.stringify(
      {
        status,
        ...(failure ? { error: failure instanceof Error ? failure.message : String(failure) } : {}),
        budgetMicrodollars: budget,
        spentMicrodollars: spentTokens * MONITOR_TOKEN_MICRODOLLARS,
        textsCompleted: lines.length,
        textsPlanned: items.length,
        thresholds: thresholdTable(lines),
        ...summarize(lines, labelled),
      },
      null,
      2,
    )}\n`,
  );
  console.log(JSON.stringify({ thresholds: thresholdTable(lines) }, null, 2));
  if (failure) throw failure;
  if (status !== "completed")
    throw new Error(`The measurement is incomplete (${status}); see ${directory}.`);
  return { status, lines };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
