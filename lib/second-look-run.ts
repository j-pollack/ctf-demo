import { createHash } from "node:crypto";
import { db } from "./db";
import { GameError } from "./policy";
import type { GameRow } from "./games";
import { infer, diagnosticText } from "./inference";
import { INVESTIGATOR_EFFORT, investigatorModel } from "./investigator-driver";
import { BOUNDED_INVESTIGATOR_POLICY } from "./investigator-evaluation-policy";
import type { MonitorJobClaim } from "./monitor-jobs";
import { screenSources } from "./monitor-route-facts";
import {
  parseSecondLook,
  SECOND_LOOK_OUTPUT_TOKENS,
  SECOND_LOOK_PLAY_LIMIT,
  secondLookMessages,
  type SecondLookAnswer,
  type SecondLookKind,
} from "./second-look";
import {
  INSTRUCTION_QUESTION_SET,
  jailbreakVerdict,
  signalsAtOrAbove,
  SECOND_LOOK_THRESHOLD,
  SYSTEM_PROMPT_QUESTION_SET,
} from "./text-screen";
import type { Message } from "@earendil-works/pi-ai";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const log = (event: string, fields: Record<string, unknown>) =>
  console.error(JSON.stringify({ event, ...fields }));

type Candidate = {
  // A screen that already holds a stored jailbreak answer. It is never asked again.
  stored: boolean;
  kind: SecondLookKind;
  ref: string;
  questionSet: string;
  text: string;
  questions: string[];
};

// The session's stored jailbreak answers, if any. Otherwise its unclear screens with no second
// look, with the text each one hashes.
async function candidates(input: {
  sessionId: string;
  messages: readonly Message[];
  systemPrompt: string | undefined;
  final: boolean;
}): Promise<Candidate[]> {
  const sources = screenSources(input.messages, input.systemPrompt);
  const texts = {
    instruction: new Map(sources.instruction.map((text) => [sha256(text), text])),
    system_prompt: new Map(sources.system_prompt.map((text) => [sha256(text), text])),
  };
  const { rows } = await db.query<{
    kind: SecondLookKind;
    ref: string;
    question_set: string;
    answers: Record<string, number>;
    second_look_verdict: string | null;
  }>(
    `SELECT kind,ref,question_set,answers,second_look_verdict FROM ctf.text_screens
     WHERE session_id=$1 AND second_look_verdict IS DISTINCT FROM 'clear' AND (
       (kind='instruction' AND question_set=$2) OR (kind='system_prompt' AND question_set=$3))
     ORDER BY created_at,ref`,
    [input.sessionId, INSTRUCTION_QUESTION_SET, SYSTEM_PROMPT_QUESTION_SET],
  );
  const found = rows.flatMap((row) => {
    const stored = row.second_look_verdict === "jailbreak";
    const text = texts[row.kind].get(row.ref);
    return stored || (text !== undefined && jailbreakVerdict(row.answers) === "unclear")
      ? [
          {
            stored,
            kind: row.kind,
            ref: row.ref,
            questionSet: row.question_set,
            text: text ?? "",
            questions: signalsAtOrAbove(row.answers, SECOND_LOOK_THRESHOLD),
          },
        ]
      : [];
  });
  // A stored jailbreak is sticky: a catch that did not commit is made again, with no request.
  if (found.some((candidate) => candidate.stored))
    return found.filter((candidate) => candidate.stored);
  return input.final ? found : found.slice(0, SECOND_LOOK_PLAY_LIMIT);
}

export type SecondLooks = {
  // The unclear questions of every screen judged a jailbreak.
  jailbreakQuestions: string[] | undefined;
  // Requests that were refused, failed or gave no valid answer. Nothing is stored for them.
  failed: number;
  // Whether any request was sent.
  asked: boolean;
};

// One request per screen, all at once under one deadline. An answer is stored on its screen row.
// A request never rejects: a refused or failed one counts as no answer.
export async function runSecondLooks(input: {
  game: GameRow;
  claim: MonitorJobClaim;
  reviewId: string;
  messages: readonly Message[];
  systemPrompt: string | undefined;
  signal: AbortSignal;
  deadlineMs: number;
  streamIdleMs?: number;
}): Promise<SecondLooks> {
  const { game, claim, reviewId } = input;
  const pending = await candidates({
    sessionId: claim.sessionId,
    messages: input.messages,
    systemPrompt: input.systemPrompt,
    final: claim.final,
  });
  if (!pending.length) return { jailbreakQuestions: undefined, failed: 0, asked: false };
  if (pending[0].stored)
    return {
      jailbreakQuestions: [...new Set(pending.flatMap((candidate) => candidate.questions))],
      failed: 0,
      asked: false,
    };
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(input.deadlineMs)]);
  let model: Awaited<ReturnType<typeof investigatorModel>> | undefined;
  try {
    model = await investigatorModel(signal);
  } catch (error) {
    log("second_look.request_failed", {
      reviewId,
      error: diagnosticText(error instanceof Error ? error.message : error),
    });
  }
  const ask = async (candidate: Candidate): Promise<SecondLookAnswer | undefined> => {
    if (!model) return undefined;
    try {
      const message = await infer(
        game,
        model,
        secondLookMessages(candidate.kind, candidate.text),
        signal,
        undefined,
        undefined,
        {
          role: "monitor",
          sessionId: claim.sessionId,
          reviewId,
          effort: INVESTIGATOR_EFFORT,
          maxOutputTokens: SECOND_LOOK_OUTPUT_TOKENS,
          stage: "second_look",
          jobClaim: claim,
          streamIdleMs: input.streamIdleMs,
          stopOnReservationOverrun: true,
          providerEndpoint: BOUNDED_INVESTIGATOR_POLICY.providerEndpoint,
        },
      );
      return parseSecondLook(message);
    } catch (error) {
      log("second_look.request_failed", {
        reviewId,
        kind: candidate.kind,
        status: error instanceof GameError ? error.status : undefined,
        error: diagnosticText(error instanceof Error ? error.message : error),
      });
      return undefined;
    }
  };
  const answers = await Promise.all(pending.map(ask));
  const jailbreakQuestions: string[] = [];
  let failed = 0;
  for (const [index, candidate] of pending.entries()) {
    const answer = answers[index];
    if (!answer) {
      failed += 1;
      continue;
    }
    await db.query(
      `UPDATE ctf.text_screens SET second_look_verdict=$5,second_look_reason=$6,second_look_review_id=$7
       WHERE session_id=$1 AND kind=$2 AND ref=$3 AND question_set=$4 AND second_look_verdict IS NULL`,
      [
        claim.sessionId,
        candidate.kind,
        candidate.ref,
        candidate.questionSet,
        answer.jailbreak ? "jailbreak" : "clear",
        answer.reason,
        reviewId,
      ],
    );
    if (answer.jailbreak) jailbreakQuestions.push(...candidate.questions);
  }
  const caught = answers.some((answer) => answer?.jailbreak);
  return {
    jailbreakQuestions: caught ? [...new Set(jailbreakQuestions)] : undefined,
    failed,
    asked: true,
  };
}
