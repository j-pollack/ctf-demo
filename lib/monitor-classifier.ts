import type { Message } from "@earendil-works/pi-ai";
import {
  combineSuspicion,
  CONTEXT_QUESTION_KEYS,
  CONTROL_DIFFICULTY,
  questionsFor,
  topTerm,
  type ClassifierRiskSignals,
  MONITOR_TOKEN_MICRODOLLARS,
} from "./control";
import { evaluateClassifierContext } from "./classifier-context";
import {
  monitorRunBudgetExempt,
  reserveInference,
  settleInference,
  transaction,
  type GameRow,
} from "./games";
import { evaluate, TYPESAFE_MODEL, type TypesafeAnswer } from "./typesafe";
import { DAILY_CAP_MICRODOLLARS, GameError, inputCeiling } from "./policy";
import { assertMonitorJobClaim, type MonitorJobClaim } from "./monitor-jobs";
import type { GameStatus } from "./types";

const noulOf = (answer: TypesafeAnswer | undefined) => {
  if (answer?.type !== "noul") throw new Error("Typesafe returned an unexpected answer shape.");
  return answer.noul;
};
const scoreOf = (answer: TypesafeAnswer | undefined) => {
  if (answer?.type !== "score") throw new Error("Typesafe returned an unexpected answer shape.");
  return answer;
};

export type ClassifierTarget = { kind: "transcript" };

async function assertDispatchAuthorization(input: {
  game: GameRow;
  sessionId: string;
  lease: string;
  executionGeneration: number;
  jobClaim: MonitorJobClaim;
}) {
  await transaction(async (client) => {
    const day = (await client.query("SELECT (now() AT TIME ZONE 'UTC')::date::text AS day")).rows[0]
      .day as string;
    await client.query("INSERT INTO ctf.daily_spend(day) VALUES($1) ON CONFLICT DO NOTHING", [day]);
    const { rows: spendRows } = await client.query<{ charged: number; reserved: number }>(
      "SELECT charged,reserved FROM ctf.daily_spend WHERE day=$1 FOR UPDATE",
      [day],
    );
    const { rows } = await client.query<{
      execution_generation: string;
      status: GameStatus;
      spent_microdollars: number;
      reserved_microdollars: number;
      budget_microdollars: number;
    }>(
      "SELECT execution_generation,status,spent_microdollars,reserved_microdollars,budget_microdollars FROM ctf.games WHERE id=$1 FOR UPDATE",
      [input.game.id],
    );
    if (!rows[0]) throw new GameError("This response has stopped.", 409);
    if (Number(spendRows[0].charged) + Number(spendRows[0].reserved) >= DAILY_CAP_MICRODOLLARS)
      throw new GameError(
        "Today’s shared inference budget is used up. Come back tomorrow (UTC).",
        429,
      );
    if (
      !monitorRunBudgetExempt(
        "monitor",
        input.jobClaim,
        Number(rows[0].spent_microdollars),
        Number(rows[0].budget_microdollars),
        rows[0].status,
      ) &&
      Number(rows[0].spent_microdollars) + Number(rows[0].reserved_microdollars) >=
        Number(rows[0].budget_microdollars)
    ) {
      const pending = Number(rows[0].reserved_microdollars) > 0;
      throw new GameError(
        pending
          ? "There isn’t enough available budget for this request. Some billing is still pending."
          : "Your inference budget is exhausted.",
        pending ? 400 : 402,
      );
    }
    await assertMonitorJobClaim(client, input.jobClaim);
  });
}

export async function classifyMonitorTarget(input: {
  game: GameRow;
  sessionId: string;
  lease: string;
  reviewId: string;
  messages: Message[];
  target: ClassifierTarget;
  signal: AbortSignal;
  executionGeneration: number;
  jobClaim: MonitorJobClaim;
}) {
  const difficulty = CONTROL_DIFFICULTY[input.game.monitor_difficulty];
  const evaluateAuthorized = async (state: unknown, questions: Parameters<typeof evaluate>[1]) => {
    await assertDispatchAuthorization(input);
    input.signal.throwIfAborted();
    // The generic reservation's 64-token minimum is conservative overhead; Typesafe bills input only.
    const reservation = await reserveInference(
      input.game.id,
      input.lease,
      "monitor",
      TYPESAFE_MODEL,
      inputCeiling({ model: TYPESAFE_MODEL, state, questions }),
      64,
      MONITOR_TOKEN_MICRODOLLARS / 1e6,
      MONITOR_TOKEN_MICRODOLLARS / 1e6,
      {
        sessionId: input.sessionId,
        reviewId: input.reviewId,
        executionGeneration: input.executionGeneration,
        jobClaim: input.jobClaim,
      },
    );
    let dispatched = false;
    try {
      input.signal.throwIfAborted();
      dispatched = true;
      const result = await evaluate(state, questions, input.signal);
      const cost = Math.round(result.inputTokens * MONITOR_TOKEN_MICRODOLLARS);
      await settleInference(reservation.id, { tokens: result.inputTokens, costMicrodollars: cost });
      if (cost > reservation.cost)
        throw new Error("Classifier usage exceeded its reserved allowance.");
      return result;
    } finally {
      if (!dispatched) await settleInference(reservation.id, { tokens: 0, cost: 0 });
    }
  };
  const contextCall = await evaluateClassifierContext(
    input.messages,
    { includeReasoning: input.game.monitor_reasoning },
    questionsFor(CONTEXT_QUESTION_KEYS),
    input.signal,
    evaluateAuthorized,
  );
  input.signal.throwIfAborted();
  const score = scoreOf(contextCall.answers.suspicion);
  const signals: ClassifierRiskSignals = {
    reads_now: 0,
    stages_indirect: 0,
    intent: noulOf(contextCall.answers.intent),
    suspicionScore: score.score,
    suspicionConfidence: score.confidence,
  };
  const suspicion = combineSuspicion(signals, difficulty);
  const reasons = {
    reads_now: "The command would read the protected file.",
    stages_indirect: "The command sets up an indirect way to read the protected file.",
    intent: "The conversation shows the agent is after the protected file.",
    suspicion: "In context, the agent's actions look like an attempt to get the protected file.",
  };
  return { signals, suspicion, reason: reasons[topTerm(signals, difficulty)] };
}
