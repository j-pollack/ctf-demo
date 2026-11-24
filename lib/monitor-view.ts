import { createHash } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";
import { db } from "./db";
import { getPublicGameRow } from "./games";
import { ROUTE_ANSWER_THRESHOLD, routingSignals } from "./monitor-route";
import { screenSources } from "./monitor-route-facts";
import { GameError } from "./policy";
import {
  INSTRUCTION_QUESTION_SET,
  injectionVerdict,
  jailbreakVerdict,
  labelSignals,
  OUTPUT_QUESTION_SET,
  SECOND_LOOK_THRESHOLD,
  signalsAtOrAbove,
  SYSTEM_PROMPT_QUESTION_SET,
} from "./text-screen";
import { DECODED_KEY_PREFIX, TOOL_QUESTION_SET } from "./tool-annotations";
import {
  runHasEnded,
  type MonitorSessionView,
  type MonitorSignal,
  type MonitorView,
} from "./types";

type Answers = Record<string, number>;
type ScreenKind = "instruction" | "system_prompt";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const strongestFirst = (signals: MonitorSignal[]) =>
  signals.toSorted((left, right) => right.value - left.value);
const signalsOf = (entries: [string, number][]) =>
  strongestFirst(entries.map(([name, value]) => ({ name, value })));

// Every query is scoped to the one run, whose owner getPublicGameRow has checked.
async function rowsOf(gameId: string) {
  const [sessions, reviews, annotations, screens, refused] = await Promise.all([
    db.query<{ id: string; ordinal: number; system_prompt: string; messages: Message[] }>(
      "SELECT id,ordinal,system_prompt,messages FROM ctf.agent_sessions WHERE game_id=$1 ORDER BY ordinal",
      [gameId],
    ),
    db.query<{
      id: string;
      session_id: string;
      route: MonitorSessionView["reviews"][number]["route"];
      verdict: MonitorSessionView["reviews"][number]["verdict"];
      reason: string | null;
      created_at: Date;
      score: number | null;
    }>(
      `SELECT r.id,r.session_id,r.route,r.verdict,r.reason,r.created_at,
        (SELECT max(least(1,greatest(0,(e.data->>'suspicion')::float8))) FROM ctf.events e
          WHERE e.game_id=r.game_id AND e.review_id=r.id AND jsonb_typeof(e.data->'suspicion')='number') AS score
       FROM ctf.monitor_reviews r WHERE r.game_id=$1 ORDER BY r.created_at,r.id`,
      [gameId],
    ),
    db.query<{
      session_id: string;
      tool_call_id: string;
      command: string | null;
      command_answers: Answers;
      outcome_answers: Answers;
    }>(
      `SELECT a.session_id,a.tool_call_id,o.command,a.command_answers,a.outcome_answers
       FROM ctf.tool_call_annotations a LEFT JOIN ctf.sprite_operations o
         ON o.game_id=a.game_id AND o.session_id=a.session_id AND o.tool_call_id=a.tool_call_id
       WHERE a.game_id=$1 AND a.question_set=$2 ORDER BY a.created_at,a.tool_call_id`,
      [gameId, TOOL_QUESTION_SET],
    ),
    db.query<{
      session_id: string;
      kind: ScreenKind | "tool_output";
      ref: string;
      answers: Answers;
      command: string | null;
      second_look_verdict: "jailbreak" | "clear" | null;
      second_look_reason: string | null;
    }>(
      `SELECT s.session_id,s.kind,s.ref,s.answers,o.command,s.second_look_verdict,s.second_look_reason
       FROM ctf.text_screens s LEFT JOIN ctf.sprite_operations o ON s.kind='tool_output'
         AND o.game_id=s.game_id AND o.session_id=s.session_id AND o.tool_call_id=s.ref
       WHERE s.game_id=$1 AND ((s.kind='tool_output' AND s.question_set=$2)
         OR (s.kind='instruction' AND s.question_set=$3) OR (s.kind='system_prompt' AND s.question_set=$4))
       ORDER BY s.created_at,s.kind,s.ref`,
      [gameId, OUTPUT_QUESTION_SET, INSTRUCTION_QUESTION_SET, SYSTEM_PROMPT_QUESTION_SET],
    ),
    db.query<{ kind: ScreenKind; text: string }>(
      "SELECT kind,text FROM ctf.refused_texts WHERE game_id=$1",
      [gameId],
    ),
  ]);
  return {
    sessions: sessions.rows,
    reviews: reviews.rows,
    annotations: annotations.rows,
    screens: screens.rows,
    refused: refused.rows,
  };
}

type Rows = Awaited<ReturnType<typeof rowsOf>>;

// Screens name their text by hash. The texts the owner already sees are this run's transcript and
// its refused texts.
function textsByHash(rows: Rows) {
  const texts = new Map<string, string>();
  const add = (kind: ScreenKind, text: string) => texts.set(`${kind}:${sha256(text)}`, text);
  for (const session of rows.sessions) {
    const sources = screenSources(session.messages, session.system_prompt);
    for (const text of sources.instruction) add("instruction", text);
    for (const text of sources.system_prompt) add("system_prompt", text);
  }
  for (const { kind, text } of rows.refused) add(kind, text);
  return texts;
}

function sessionView(
  session: Rows["sessions"][number],
  rows: Rows,
  texts: Map<string, string>,
): MonitorSessionView {
  const own = <T extends { session_id: string }>(list: T[]) =>
    list.filter((row) => row.session_id === session.id);
  const annotations = own(rows.annotations);
  const isDecoded = (row: { tool_call_id: string }) =>
    row.tool_call_id.startsWith(DECODED_KEY_PREFIX);
  const commands = annotations
    .filter((row) => !isDecoded(row))
    .map((row) => ({
      toolCallId: row.tool_call_id,
      command: row.command,
      signals: signalsOf([
        ...routingSignals(row.command_answers),
        ...routingSignals(row.outcome_answers),
      ]),
    }));
  const screens = own(rows.screens);
  const outputs = screens.filter((row) => row.kind === "tool_output");
  const flagged = outputs.filter((row) => injectionVerdict(row.answers));
  // An instruction screen whose hash is none of the run's texts is a decoded layer's.
  const decodedScreen = (row: (typeof screens)[number]) =>
    row.kind === "instruction" && !texts.has(`instruction:${row.ref}`);
  const prompts = screens.flatMap(({ kind, ...row }) =>
    kind === "tool_output" || decodedScreen({ kind, ...row }) ? [] : [{ ...row, kind }],
  );
  const shown = prompts.flatMap((row) => {
    const verdict = jailbreakVerdict(row.answers);
    return verdict === "clear" ? [] : [{ row, verdict }];
  });
  return {
    id: session.id,
    ordinal: session.ordinal,
    reviews: own(rows.reviews).map((row) => ({
      id: row.id,
      route: row.route,
      verdict: row.verdict,
      reason: row.reason,
      createdAt: row.created_at.toISOString(),
      score: row.score,
    })),
    commands: commands.filter((command) => command.signals.length > 0),
    commandsUnder: commands.filter((command) => command.signals.length === 0).length,
    outputs: flagged.map((row) => ({
      toolCallId: row.ref,
      command: row.command,
      signals: signalsOf(labelSignals(row.answers)),
    })),
    outputsUnder: outputs.length - flagged.length,
    screens: shown.map(({ row, verdict }) => ({
      kind: row.kind,
      verdict,
      signals: strongestFirst(
        signalsAtOrAbove(row.answers, SECOND_LOOK_THRESHOLD).map((name) => ({
          name,
          value: row.answers[name],
        })),
      ),
      text: texts.get(`${row.kind}:${row.ref}`) ?? null,
      secondLook: row.second_look_verdict
        ? { verdict: row.second_look_verdict, reason: row.second_look_reason }
        : null,
    })),
    screensUnder: prompts.length - shown.length,
    decoded: decodedLayers(annotations.filter(isDecoded), screens.filter(decodedScreen)),
  };
}

// One entry per decoded layer, in the order it was first stored. No text is sent.
function decodedLayers(
  annotations: Rows["annotations"],
  screens: Rows["screens"],
): MonitorSessionView["decoded"] {
  const refs = [
    ...new Set([
      ...annotations.map((row) => row.tool_call_id.slice(DECODED_KEY_PREFIX.length)),
      ...screens.map((row) => row.ref),
    ]),
  ];
  return refs.map((ref) => {
    const annotation = annotations.find((row) => row.tool_call_id === DECODED_KEY_PREFIX + ref);
    const screen = screens.find((row) => row.ref === ref);
    return {
      ref,
      flagRead: annotation ? signalsOf(routingSignals(annotation.command_answers)) : null,
      screen: screen
        ? {
            verdict: jailbreakVerdict(screen.answers),
            signals: strongestFirst(
              signalsAtOrAbove(screen.answers, SECOND_LOOK_THRESHOLD).map((name) => ({
                name,
                value: screen.answers[name],
              })),
            ),
            secondLook: screen.second_look_verdict
              ? { verdict: screen.second_look_verdict, reason: screen.second_look_reason }
              : null,
          }
        : null,
    };
  });
}

// What the monitor saw in an ended run, for its owner only. A run still in play gets 409, so the
// view cannot steer it.
export async function monitorView(gameId: string, ownerId: string): Promise<MonitorView> {
  const game = await getPublicGameRow(gameId, ownerId);
  if (!runHasEnded(game.status))
    throw new GameError("What the monitor saw opens after the run ends.", 409);
  const rows = await rowsOf(game.id);
  const texts = textsByHash(rows);
  return {
    commandThreshold: ROUTE_ANSWER_THRESHOLD,
    sessions: rows.sessions.map((session) => sessionView(session, rows, texts)),
  };
}
