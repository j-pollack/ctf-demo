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
  finalizing: "Finalizing",
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
  if (status === "caught-up") return "All sessions reviewed.";
  if (status === "caught" || pendingSessions === 0) return null;
  const sessions = `${number(pendingSessions)} of ${number(totalSessions)} ${totalSessions === 1 ? "session" : "sessions"}`;
  return status === "unresolved"
    ? `${sessions} not fully reviewed.`
    : `${sessions} waiting for review.`;
}
export const monitorStatusLabel: Record<NonNullable<PublicGame["monitor"]>["status"], string> = {
  queued: "Queued",
  reviewing: "Reviewing",
  "caught-up": "Caught up",
  unresolved: "Unresolved",
  caught: "Caught",
};
