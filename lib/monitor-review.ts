import type { GameRow } from "./games";
import type { MonitorSnapshot } from "./types";
import type { MonitorJobClaim } from "./monitor-jobs";
import type { ClassifierRiskSignals } from "./control";
export {
  MONITOR_CALL_LIMIT,
  INVESTIGATOR_MODEL,
  INVESTIGATOR_EFFORT,
  createInvestigatorAgent,
  guardInvestigatorStream,
  runInvestigatorDriver,
  investigatorCallsOf,
  investigatorForcedOf,
  investigatorContinuationsOf,
  budgetLine,
} from "./investigator-driver";

export type MonitorTarget = { kind: "transcript" };
export type RunMonitorReviewInput = {
  game: GameRow;
  reviewId: string;
  snapshot: MonitorSnapshot;
  currentSessionId: string;
  target: MonitorTarget;
  riskSignals: ClassifierRiskSignals;
  signal: AbortSignal;
  deadlineAt?: number;
  // Shortens the idle bound of the review's requests; tests only.
  streamIdleMs?: number;
  // Model requests this review may make, 1 to 32. Production leaves it unset.
  callLimit?: number;
  jobClaim?: MonitorJobClaim;
  includeReasoning?: boolean;
};

function validateTarget(target: MonitorTarget) {
  if (
    !target ||
    typeof target !== "object" ||
    target.kind !== "transcript" ||
    Object.keys(target).length !== 1
  )
    throw new Error("Invalid monitor target.");
  return target;
}

export function validateReviewScope(input: RunMonitorReviewInput) {
  const target = validateTarget(input.target);
  const snapshot = structuredClone(input.snapshot);
  if (
    !input.reviewId ||
    snapshot.gameId !== input.game.id ||
    snapshot.userId !== input.game.owner_id ||
    snapshot.targetSessionId !== input.currentSessionId ||
    !snapshot.sessions.some((session) => session.id === input.currentSessionId)
  )
    throw new Error("Monitor review scope does not match the captured snapshot.");
  return { target, snapshot };
}
