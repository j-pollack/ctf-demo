import { endBanner } from "@/app/run-end";
import {
  RUN_BUDGET_MICRODOLLARS,
  type AgentEffort,
  type GameStatus,
  type GameSummary,
  type PublicGame,
} from "@/lib/types";

export const label = (model: string) => model.split("/")[1] ?? model;
export const EFFORT_NAMES: Record<AgentEffort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};
export const number = (value: number) => value.toLocaleString("en-US");
export const money = (value: number) => `$${(value / 1_000_000).toFixed(4)}`;
export const RUN_BUDGET = `$${(RUN_BUDGET_MICRODOLLARS / 1_000_000).toFixed(2)}`;
export const statusLabel: Record<GameStatus, string> = {
  creating: "Starting",
  active: "In progress",
  finalizing: "Final review",
  captured: "Won",
  exhausted: "Out of budget",
  ended: "Ended",
  blocked: "Blocked",
  caught: "Caught",
};
// An ended run says how it ended, as the run page does.
export function runEndLabel(run: Pick<GameSummary, "status" | "submissionCorrect" | "endReason">) {
  if (run.status !== "ended" || (run.submissionCorrect === undefined && !run.endReason))
    return statusLabel[run.status];
  return endBanner(
    run.status,
    run.submissionCorrect === undefined
      ? undefined
      : { correct: run.submissionCorrect, submissionTransport: "http" },
    run.endReason,
  ).heading;
}
export function monitorProgressText(
  status: NonNullable<PublicGame["monitor"]>["status"],
  pendingSessions: number,
  totalSessions: number,
) {
  // Nothing is waiting in these states, so there is no count to show.
  if (status === "caught-up" || status === "caught" || pendingSessions === 0) return null;
  const sessions = `${number(pendingSessions)} of ${number(totalSessions)} ${totalSessions === 1 ? "session" : "sessions"}`;
  return status === "unresolved"
    ? `${sessions} not fully reviewed.`
    : `${sessions} waiting for review.`;
}
// What the monitor's review is doing or found. "Caught" is the word for losing, so the state where
// the review is up to date and found nothing does not use it. An up to date run is not a finished
// one: sessions are reviewed in full when the flag is uploaded.
export const monitorStatusLabel: Record<NonNullable<PublicGame["monitor"]>["status"], string> = {
  queued: "Review queued",
  reviewing: "Under review",
  settling: "Checking a command",
  "caught-up": "Up to date",
  unresolved: "Review incomplete",
  caught: "Caught",
};
// Shown in place of the texts that read as final while a failed review has requeues left.
export const REVIEW_WILL_RETRY_TEXT =
  "The review failed and will be retried. The result is not confirmed yet.";
export const MONITOR_STATUS_LOADING = "Waiting for review status";
