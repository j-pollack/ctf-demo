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

const COPY = {
  "sign-in": {
    unavailable: "Email sign-in is temporarily unavailable. Try again in a few minutes.",
    tooMany: "Too many sign-in emails were requested. Wait a minute, then try again.",
    failed: "Could not send your sign-in link. Try again.",
  },
  confirmation: {
    unavailable: "Email is temporarily unavailable. Try again in a few minutes.",
    tooMany: "Too many emails were requested. Wait a minute, then try again.",
    failed: "Could not send your confirmation link. Try again.",
  },
} as const;

// Turns a Resend send failure into a player-facing status and message, and logs the provider's reason for
// operators. Never logs the API key or the recipient address.
export function signInEmailError(
  error: {
    name?: string | null;
    statusCode?: number | null;
    message?: string | null;
  },
  purpose: keyof typeof COPY = "sign-in",
) {
  const copy = COPY[purpose];
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
      message: copy.unavailable,
    } as const;
  // Quota names also arrive as 429, so they are matched above.
  if (error.name === "rate_limit_exceeded" || error.statusCode === 429)
    return {
      status: "TOO_MANY_REQUESTS",
      message: copy.tooMany,
    } as const;
  return {
    status: "BAD_GATEWAY",
    message: copy.failed,
  } as const;
}

// One account per mailbox: lowercases, drops any "+tag" and, for Gmail, the dots it ignores, so variants
// of an address can't each claim a fresh budget and run allowance. The sign-in link goes to the result,
// so only rewrites the provider itself honours are safe: dots stay significant on other domains.
// An address with nothing before the plus stays invalid.
export function canonicalEmail(email: string) {
  const address = email.trim().toLowerCase();
  const at = address.lastIndexOf("@");
  if (at < 0) return address;
  const local = address.slice(0, at).split("+")[0];
  const domain = address.slice(at + 1);
  return GMAIL.has(domain) ? `${local.replaceAll(".", "")}@gmail.com` : `${local}@${domain}`;
}
const GMAIL = new Set(["gmail.com", "googlemail.com"]);
