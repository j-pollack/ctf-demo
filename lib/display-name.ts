import { DISPLAY_NAME_PATTERN, DISPLAY_NAME_RULE } from "./display-name-rule";
import { GameError } from "./policy";
import type { TypesafeAnswer, TypesafeQuestion } from "./typesafe";

// The same compilation a browser gives the input's pattern attribute.
const VALID = new RegExp(`^(?:${DISPLAY_NAME_PATTERN})$`, "v");

// Untrusted input in, a known-good name out. Surrounding whitespace is dropped; nothing else is.
export function parseDisplayName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!VALID.test(name)) throw new GameError(DISPLAY_NAME_RULE, 400);
  return name;
}

const CONTEXT =
  "`name` is a display name a player chose for the public leaderboard of an online hacking game.";
const question = (instructions: string, yes: string, no: string): TypesafeQuestion => ({
  type: "noul",
  instructions: `${CONTEXT} ${instructions}`,
  criteria: { true: yes, false: no },
});

export const DISPLAY_NAME_QUESTION_SET = "display-name-v1";
export const DISPLAY_NAME_QUESTIONS: Record<string, TypesafeQuestion> = {
  offensive: question(
    "Is `name` rude, hateful or harassing, read in any language and with letters swapped for digits or symbols?",
    "It contains a slur, an insult aimed at a person or group, a threat, or praise of hate or violence.",
    "It is an ordinary handle, a joke without a target, or a word that only looks like a bad word.",
  ),
  sexual: question(
    "Is `name` sexual or obscene, read in any language and with letters swapped for digits or symbols?",
    "It names a sex act or body part, or is crude profanity.",
    "It is an ordinary handle.",
  ),
  impersonates: question(
    "Does `name` pose as someone who runs or speaks for the game?",
    "It claims to be staff, an admin, a moderator, the system, the game or its monitor.",
    "It is a player's own handle, including one that mentions hacking or security.",
  ),
};
// Measured on real Jev over 40 labelled names (docs/plans/display-name.md, Evidence): at 0.6 one of
// 25 ordinary names was refused and none of 15 bad ones was allowed. The closest bad name scored 0.66.
export const NAME_REFUSAL_THRESHOLD = 0.6;

// Every question must come back as a Noul. Anything less is no verdict, and the caller fails closed.
export function nameScores(answers: Record<string, TypesafeAnswer>): Record<string, number> {
  return Object.fromEntries(
    Object.keys(DISPLAY_NAME_QUESTIONS).map((name) => {
      const answer = answers[name];
      if (answer?.type !== "noul") throw new Error(`Jev gave no usable answer for "${name}".`);
      return [name, answer.noul];
    }),
  );
}

export function nameVerdict(scores: Record<string, number>): "allowed" | "refused" {
  return Object.values(scores).some((score) => score >= NAME_REFUSAL_THRESHOLD)
    ? "refused"
    : "allowed";
}
