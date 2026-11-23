import type { GameEvent, GameStatus, PublicGame } from "@/lib/types";

// The end-of-run banner. Only a capture is a win (the green `terminal`); every other terminal
// state is a loss and gets the `loss` styling. `detail` says why, for a loss.
const UNVERIFIED_DETAIL = {
  "unverified-review":
    "The review could not be completed after repeated attempts, so this run ended with no result. Start a new run to try again.",
  "unverified-scoring":
    "Scoring could not be completed, so this run ended with no result. Start a new run to try again.",
  "unverified-allowance":
    "The monitor’s budget for this run ran out before every session was reviewed, so this run ended with no result. Start a new run to try again.",
} as const;
export function endBanner(
  status: GameStatus,
  submit?: Pick<GameEvent, "correct" | "submissionTransport">,
  endReason?: PublicGame["endReason"],
) {
  const win = status === "captured";
  const http = submit?.submissionTransport === "http";
  const [heading, detail] = win
    ? ["You won", ""]
    : endReason
      ? ["No result", UNVERIFIED_DETAIL[endReason]]
      : status === "exhausted"
        ? ["Out of budget", "This run used up its budget. Start a new run to try again."]
        : submit?.correct
          ? [
              "Right flag, but no bug fixed",
              http
                ? "The uploaded contents matched the flag, but you also need at least one bug fixed. Start a new run to try again."
                : "The agent handed in the correct flag, but you also need at least one bug fixed. Start a new run to try again.",
            ]
          : submit?.correct === false
            ? [
                "Wrong flag",
                http
                  ? "The uploaded contents did not match the flag, and you only get one try. Start a new run to try again."
                  : "The agent handed in something that isn’t the flag, and you only get one try. Start a new run to try again.",
              ]
            : ["This run has ended", "Start a new run to try again."];
  return { win, className: `terminal${win ? "" : " loss"}`, heading, detail };
}
