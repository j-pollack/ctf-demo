// Explicit fixture budgets; native AbortSignals and database clocks remain real.
export const fastMonitorTiming = Object.freeze({
  deadlineMs: 3_000,
  classifierDeadlineMs: 1_000,
  annotationDeadlineMs: 1_000,
  // Without it, the 3-second deadline would force every review to decide on its second request.
  forceDecisionMs: 500,
});
export const fastMonitorDelays = Object.freeze({
  successMs: 500,
  investigatorMs: 10_000,
  classifierMs: 5_000,
});
