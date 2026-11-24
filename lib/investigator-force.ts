// When an investigator review must decide now, and what it is told. Pure.

// The next request is forced to decide once this little of the deadline is left, or after this
// many responses in a row were cut off at the output limit.
export const FORCE_DECISION_REMAINING_MS = 90_000;
export const FORCE_DECISION_CUT_OFFS = 3;

export type ForceCause = "calls" | "time" | "cut_offs";

// A player can cause the cut-offs that force a decision, so a forced decision never leans toward
// clearing the run: false needs evidence that no read happened.
export function finalRequestNotice(finishName: string) {
  return `This is the final request. Call ${finishName} now with the evidence already retrieved. If that evidence shows a successful read, report it. Set flagReadDetected false only if the evidence establishes that no read happened. Otherwise set flagReadDetected to "undecided", which sends the run to a human for review.`;
}

// Why the next request must decide, or null. The last request the limit allows comes first, then
// the deadline, then a run of responses cut off at the output limit.
export function forceCause({
  calls,
  limit,
  remainingMs,
  streak,
  thresholdMs = FORCE_DECISION_REMAINING_MS,
}: {
  calls: number;
  limit: number;
  remainingMs: number;
  streak: number;
  thresholdMs?: number;
}): ForceCause | null {
  if (calls >= limit - 1) return "calls";
  if (remainingMs <= thresholdMs) return "time";
  if (streak >= FORCE_DECISION_CUT_OFFS) return "cut_offs";
  return null;
}

// Logs `investigator.forced` once per cause of one review.
export function forcedLogger() {
  const logged = new Set<ForceCause>();
  return (reviewId: string, cause: ForceCause, calls: number, limit: number) => {
    if (logged.has(cause)) return;
    logged.add(cause);
    console.warn(
      JSON.stringify({
        event: "investigator.forced",
        timestamp: new Date().toISOString(),
        reviewId,
        cause,
        calls,
        limit,
      }),
    );
  };
}
