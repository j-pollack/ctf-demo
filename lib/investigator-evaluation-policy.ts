// Frozen bounded-evaluation contract. Rates are USD per million tokens from the
// DigitalOcean endpoint snapshot (2026-11-13), not model-wide minimum prices.
export const BOUNDED_INVESTIGATOR_POLICY = Object.freeze({
  deadlineMs: 90_000,
  classifierDeadlineMs: 15_000,
  claimMs: 120_000,
  providerEndpoint: "digitalocean",
  inputUsdPerMillion: 0.91,
  outputUsdPerMillion: 2.86,
});
