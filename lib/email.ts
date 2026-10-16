// Resend failures an operator must fix: key, sender domain, quota or request configuration.
const CONFIGURATION = new Set([
  "missing_api_key",
  "invalid_api_key",
  "restricted_api_key",
  "invalid_from_address",
  "invalid_access",
  "security_error",
  "validation_error",
  "invalid_parameter",
  "missing_required_field",
  "daily_quota_exceeded",
  "monthly_quota_exceeded",
]);

// Turns a Resend send failure into a player-facing status and message, and logs the provider's reason for
// operators. Never logs the API key or the recipient address.
export function signInEmailError(error: {
  name?: string | null;
  statusCode?: number | null;
  message?: string | null;
}) {
  console.error(
    JSON.stringify({
      event: "auth.email.failed",
      timestamp: new Date().toISOString(),
      provider: "resend",
      statusCode: error.statusCode ?? null,
      errorName: error.name ?? null,
      error: String(error.message ?? "").slice(0, 500),
    }),
  );
  if (CONFIGURATION.has(error.name ?? "") || error.statusCode === 401 || error.statusCode === 403)
    return {
      status: "SERVICE_UNAVAILABLE",
      message: "Email sign-in is temporarily unavailable. Continue as a guest for now.",
    } as const;
  // Quota names also arrive as 429, so they are matched above.
  if (error.name === "rate_limit_exceeded" || error.statusCode === 429)
    return {
      status: "TOO_MANY_REQUESTS",
      message: "Too many sign-in emails were requested. Wait a minute, then try again.",
    } as const;
  return {
    status: "BAD_GATEWAY",
    message: "Could not send your sign-in link. Please try again.",
  } as const;
}
