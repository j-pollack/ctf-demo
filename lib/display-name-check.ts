import { randomUUID } from "node:crypto";
import { MONITOR_TOKEN_MICRODOLLARS } from "./control";
import { db } from "./db";
import {
  DISPLAY_NAME_QUESTION_SET,
  DISPLAY_NAME_QUESTIONS,
  NAME_REFUSAL_THRESHOLD,
  nameScores,
  nameVerdict,
  parseDisplayName,
} from "./display-name";
import { settleInference, transaction } from "./games";
import { diagnosticText } from "./inference";
import { DAILY_CAP_MICRODOLLARS, GameError, inputCeiling } from "./policy";
import { evaluate, TYPESAFE_MODEL } from "./typesafe";

export const NAME_CHECK_DEADLINE_MS = 3000;
export const NAME_CHECKS_PER_DAY = 20;
const TAKEN = "That name is taken.";
const REFUSED = "That name can't be used on the leaderboard. Try another.";
const UNAVAILABLE = "We couldn't check that name right now. Try again.";
const LIMIT = "You've checked too many names today. Try again tomorrow.";
const PAUSED = "Name checks are paused until tomorrow (UTC). Try again then.";

// A name check belongs to an account, not a run: role `account`, no game. It is held under the
// shared daily cap and counted against the account's daily limit, both under the day's row lock.
// ponytail: the day's row lock serializes every reservation; fine at this traffic.
async function reserveCheck(userId: string, ceiling: number) {
  return transaction(async (client) => {
    const day = (await client.query("SELECT (now() AT TIME ZONE 'UTC')::date::text AS day")).rows[0]
      .day as string;
    await client.query("INSERT INTO ctf.daily_spend(day) VALUES($1) ON CONFLICT DO NOTHING", [day]);
    const spend = (
      await client.query("SELECT charged,reserved FROM ctf.daily_spend WHERE day=$1 FOR UPDATE", [
        day,
      ])
    ).rows[0];
    const used = (
      await client.query(
        "SELECT count(*)::int AS n FROM ctf.inference WHERE user_id=$1 AND role='account' AND day=$2",
        [userId, day],
      )
    ).rows[0].n as number;
    if (used >= NAME_CHECKS_PER_DAY) throw new GameError(LIMIT, 429);
    const cost = Math.ceil(ceiling * MONITOR_TOKEN_MICRODOLLARS);
    if (Number(spend.charged) + Number(spend.reserved) + cost > DAILY_CAP_MICRODOLLARS)
      throw new GameError(PAUSED, 503);
    const id = randomUUID();
    await client.query("UPDATE ctf.daily_spend SET reserved=reserved+$2 WHERE day=$1", [day, cost]);
    await client.query(
      "INSERT INTO ctf.inference(id,user_id,day,role,model,token_ceiling,cost_ceiling) VALUES($1,$2,$3,'account',$4,$5,$6)",
      [id, userId, day, TYPESAFE_MODEL, ceiling, cost],
    );
    return { id, cost };
  });
}

// Asks Jev once and settles the hold. Usage that came back is billed as reported; a call without
// it at its ceiling. Any failure to reach a verdict refuses the save: names are public.
async function checkName(userId: string, name: string) {
  const state = { name };
  const ceiling = inputCeiling({ model: TYPESAFE_MODEL, state, questions: DISPLAY_NAME_QUESTIONS });
  const reservation = await reserveCheck(userId, ceiling);
  let tokens = ceiling;
  try {
    const result = await evaluate(
      state,
      DISPLAY_NAME_QUESTIONS,
      AbortSignal.timeout(NAME_CHECK_DEADLINE_MS),
    );
    tokens = result.inputTokens;
    const scores = nameScores(result.answers);
    const outcome = nameVerdict(scores);
    // One record per verdict, so the threshold can be recalibrated from real refusals.
    console.info(
      JSON.stringify({
        event: "display_name.checked",
        questionSet: DISPLAY_NAME_QUESTION_SET,
        userId,
        name,
        scores,
        threshold: NAME_REFUSAL_THRESHOLD,
        outcome,
      }),
    );
    return outcome;
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "display_name.check_failed",
        userId,
        error: diagnosticText(error instanceof Error ? error.message : error),
      }),
    );
    throw new GameError(UNAVAILABLE, 503);
  } finally {
    await settleInference(reservation.id, {
      tokens,
      costMicrodollars: Math.min(Math.round(tokens * MONITOR_TOKEN_MICRODOLLARS), reservation.cost),
    });
  }
}

// Sets the caller's own name. Validation, then a free uniqueness check, then Jev; the unique index
// decides a race between two accounts that both passed the early check.
export async function saveDisplayName(userId: string, input: unknown) {
  const name = parseDisplayName(input);
  const holder = (
    await db.query<{ id: string; displayName: string }>(
      `SELECT id,"displayName" FROM ctf."user" WHERE lower("displayName")=lower($1)`,
      [name],
    )
  ).rows[0];
  if (holder && holder.id !== userId) throw new GameError(TAKEN, 409);
  if (holder?.displayName === name) return name;
  if ((await checkName(userId, name)) === "refused") throw new GameError(REFUSED, 422);
  try {
    await db.query(`UPDATE ctf."user" SET "displayName"=$2,"updatedAt"=now() WHERE id=$1`, [
      userId,
      name,
    ]);
  } catch (error) {
    const { code, constraint } = error as { code?: string; constraint?: string };
    if (code === "23505" && constraint === "user_display_name_unique")
      throw new GameError(TAKEN, 409);
    throw error;
  }
  return name;
}
