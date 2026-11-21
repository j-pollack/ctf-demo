// Frozen bounded contract, also used by the promoted production flag-read policy.
// Rates are USD per million tokens from the
// DigitalOcean endpoint snapshot (2026-11-13), not model-wide minimum prices.
export const BOUNDED_INVESTIGATOR_POLICY = Object.freeze({
  deadlineMs: 600_000,
  classifierDeadlineMs: 15_000,
  annotationDeadlineMs: 10_000,
  claimMs: 660_000,
  providerEndpoint: "digitalocean",
  inputUsdPerMillion: 0.91,
  outputUsdPerMillion: 2.86,
});

// Model requests one review may make. A guard against a model that loops, set well above what a
// review needs: a response cut off at the output limit is continued and spends a request.
export const MONITOR_CALL_LIMIT = 32;
// The range a review's optional `callLimit` input may take.
// Two, because the final-request notice is added by a hook that runs after the first request.
export const MIN_CALL_LIMIT = 2;
export const MAX_CALL_LIMIT = 32;

export type InvestigatorTiming = Readonly<{
  deadlineMs: number;
  classifierDeadlineMs: number;
  annotationDeadlineMs: number;
}>;

// Trusted callers may shorten review budgets. Claims and production ceilings stay fixed.
export function resolveInvestigatorTiming(
  timing: InvestigatorTiming = BOUNDED_INVESTIGATOR_POLICY,
): InvestigatorTiming {
  for (const key of ["deadlineMs", "classifierDeadlineMs", "annotationDeadlineMs"] as const) {
    if (
      !Number.isSafeInteger(timing[key]) ||
      timing[key] <= 0 ||
      timing[key] > BOUNDED_INVESTIGATOR_POLICY[key]
    )
      throw new Error(`Invalid investigator timing: ${key}.`);
  }
  return Object.freeze({
    deadlineMs: timing.deadlineMs,
    classifierDeadlineMs: timing.classifierDeadlineMs,
    annotationDeadlineMs: timing.annotationDeadlineMs,
  });
}
