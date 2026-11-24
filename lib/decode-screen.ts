// The one screened path for decoded text inside a review, from the decode tool or a read
// confirmation's trace. Each text gets the jailbreak screen of player instructions (the screen and,
// under the run's rule, the second look, with their thresholds and stored rows) and the flag-read
// command questions every command gets. Encoding is a known way to hide a prompt injection.
import { createHash } from "node:crypto";
import { db } from "./db";
import type { GameRow } from "./games";
import type { MonitorJobClaim } from "./monitor-jobs";
import type { LayerScreen } from "./decode-layers";
import { routingSignals } from "./monitor-route";
import { runSecondLooks } from "./second-look-run";
import { SECOND_LOOK_DEADLINE_MS } from "./second-look";
import { annotateDecodedLayers } from "./tool-annotations";
import {
  CATCH_THRESHOLD,
  INSTRUCTION_QUESTION_SET,
  SECOND_LOOK_THRESHOLD,
  createScreenBreaker,
  jailbreakVerdict,
  screenTexts,
  signalsAtOrAbove,
} from "./text-screen";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const log = (event: string, fields: Record<string, unknown>) =>
  console.error(JSON.stringify({ event, ...fields }));
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

type Stored = { answers: Record<string, number>; second_look_verdict: string | null };

// The stored screen rows of these texts, by ref.
async function storedScreens(sessionId: string, texts: readonly string[]) {
  const { rows } = await db.query<Stored & { ref: string }>(
    `SELECT ref,answers,second_look_verdict FROM ctf.text_screens
     WHERE session_id=$1 AND kind='instruction' AND question_set=$2 AND ref=ANY($3::text[])`,
    [sessionId, INSTRUCTION_QUESTION_SET, texts.map(sha256)],
  );
  return new Map(rows.map((row) => [row.ref, row]));
}

// A stored second look decides over the first pass.
function verdictOf(row: Stored | undefined): Pick<LayerScreen, "verdict" | "questions"> {
  if (!row) return { verdict: undefined, questions: [] };
  if (row.second_look_verdict === "jailbreak")
    return { verdict: "certain", questions: signalsAtOrAbove(row.answers, SECOND_LOOK_THRESHOLD) };
  if (row.second_look_verdict === "clear") return { verdict: "clear", questions: [] };
  return {
    verdict: jailbreakVerdict(row.answers),
    questions: signalsAtOrAbove(row.answers, CATCH_THRESHOLD),
  };
}

export function createDecodedScreen(input: {
  game: GameRow;
  claim: MonitorJobClaim | undefined;
  reviewId: string;
  signal: AbortSignal;
  streamIdleMs?: number;
  // Fails the review, as the worker fails a final review whose second look gave no answer.
  fail: (error: unknown) => void;
}) {
  return async (texts: string[]): Promise<LayerScreen[]> => {
    const { game, claim, reviewId, signal } = input;
    if (!claim) throw new Error("A decoded layer cannot be screened without a review claim.");
    const sessionId = claim.sessionId;
    const generation = Number(game.execution_generation ?? 0);
    const unique = [...new Set(texts)];
    // A stored row is reused, never screened or paid for again and never replaced.
    const before = await storedScreens(sessionId, unique);
    const context = {
      game,
      sessionId,
      lease: "",
      generation,
      stop: signal,
      breaker: createScreenBreaker(),
      review: { reviewId, jobClaim: claim },
    };
    // One batch under one reservation. Each text still gets its own request and stored row.
    const fresh = unique.filter((text) => !before.has(sha256(text)));
    const [, flagRead] = await Promise.all([
      fresh.length
        ? screenTexts(
            context,
            fresh.map((text) => ({ kind: "instruction" as const, text })),
          )
        : undefined,
      annotateDecodedLayers({
        game,
        sessionId,
        reviewId,
        texts: unique,
        signal,
        executionGeneration: generation,
        jobClaim: claim,
      }).catch((error: unknown) => {
        log("decode.annotation_failed", { reviewId, error: messageOf(error) });
        return unique.map(() => undefined);
      }),
    ]);
    let rows = await storedScreens(sessionId, unique);
    const result = () =>
      texts.map((text) => {
        const answers = flagRead[unique.indexOf(text)];
        return {
          ...verdictOf(rows.get(sha256(text))),
          flagRead: answers ? routingSignals(answers) : undefined,
        };
      });
    const first = result();
    // A certain verdict under the rule is a catch already: no second look is needed.
    if (!game.jailbreak_catch || first.some((screen) => screen.verdict === "certain")) return first;
    const unclear = unique.filter(
      (text) => verdictOf(rows.get(sha256(text))).verdict === "unclear",
    );
    if (!unclear.length) return first;
    try {
      const looks = await runSecondLooks({
        game,
        claim,
        reviewId,
        messages: [],
        systemPrompt: undefined,
        signal,
        deadlineMs: SECOND_LOOK_DEADLINE_MS,
        streamIdleMs: input.streamIdleMs,
        texts: unclear,
      });
      // A text could tell the model not to answer, so a final review does not go on without one.
      if (looks.failed && claim.final)
        input.fail(new Error("A second look gave no valid answer on a final review."));
      rows = await storedScreens(sessionId, unique);
    } catch (error) {
      log("decode.second_look_failed", { reviewId, error: messageOf(error) });
      // A final review does not go on without a second look's answer, whatever stopped it.
      if (claim.final) input.fail(error);
      return first;
    }
    return result();
  };
}
