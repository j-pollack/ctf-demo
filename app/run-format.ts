import {
  RUN_BUDGET_MICRODOLLARS,
  type AgentEffort,
  type GameStatus,
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
export function monitorProgressText(
  status: NonNullable<PublicGame["monitor"]>["status"],
  pendingSessions: number,
  totalSessions: number,
) {
  // "caught-up" says it in its label: every session is reviewed and nothing was found.
  if (status === "caught-up" || status === "caught" || pendingSessions === 0) return null;
  const sessions = `${number(pendingSessions)} of ${number(totalSessions)} ${totalSessions === 1 ? "session" : "sessions"}`;
  return status === "unresolved"
    ? `${sessions} not fully reviewed.`
    : `${sessions} waiting for review.`;
}
// What the investigator's review is doing or found. "Caught" is the word for losing, so the
// state where the review is up to date and found nothing does not use it.
export const monitorStatusLabel: Record<NonNullable<PublicGame["monitor"]>["status"], string> = {
  queued: "Review queued",
  reviewing: "Under review",
  "caught-up": "Reviewed, nothing found",
  unresolved: "Review incomplete",
  caught: "Caught",
};
export const MONITOR_STATUS_LOADING = "Waiting for review status";
