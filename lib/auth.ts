import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { anonymous, magicLink } from "better-auth/plugins";
import { after } from "next/server";
import { Resend } from "resend";
import { db } from "./db";
import { canonicalEmail, signInEmailError } from "./email";

// Previews have no fixed origin: accept only this deployment's own Vercel hostnames.
const vercelHosts = [process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL].filter(
  (host): host is string => !!host,
);

// SITE_URL is the app's public origin, a tunnel in local development. Serve auth on it beside
// BETTER_AUTH_URL, so magic links and sign-in work through the tunnel and on localhost alike.
const siteHost = URL.canParse(process.env.SITE_URL ?? "") && new URL(process.env.SITE_URL!).host;

// Every account email goes through Resend. A failure carries a player-facing message.
async function sendEmail(
  to: string,
  subject: string,
  text: string,
  purpose: "sign-in" | "confirmation" = "sign-in",
) {
  if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM)
    throw new Error("Email sign-in is not configured.");
  const result = await new Resend(process.env.RESEND_API_KEY).emails.send({
    from: process.env.RESEND_FROM,
    to,
    subject,
    text,
  });
  if (result.error) {
    const { status, message } = signInEmailError(result.error, purpose);
    // A plain Error becomes an empty 500; APIError carries the message to the player.
    throw new APIError(status, { message });
  }
  // A success leaves a line too: email-change sends run after the response, so the log is the only
  // place that shows whether one went out. The subject says which email; no address is logged.
  console.info(JSON.stringify({ event: "auth.email.sent", purpose, subject }));
}
const IGNORE = "If you didn't request it, ignore this email.";
// Both email-change links carry the caller's callback; each step reports its own outcome instead.
const landing = (url: string, step: "confirmed" | "changed") => {
  const link = new URL(url);
  link.searchParams.set("callbackURL", `/account?email=${step}`);
  return link.toString();
};
// Better Auth sends email-change links in the background. Running them after the response means a
// new address and one that is already taken answer at the same speed, so timing reveals no account.
// Outside a Next request, in scripts and tests, `after` throws: the send is already running and
// Better Auth logs its failure. In production that means nothing keeps the function alive for it.
function afterResponse(task: Promise<unknown>) {
  try {
    after(() => task);
  } catch (error) {
    if (process.env.NODE_ENV === "production")
      console.error(
        JSON.stringify({
          event: "auth.background_task_unawaited",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
  }
}
// Guests have no inbox, and an unverified account skips the current-inbox step, so neither can move
// an account to another address.
const CHANGE_REFUSED = "Only a verified email can be changed. Sign in with an email link first.";
// Paths whose `email` or `newEmail` names a mailbox an account will use.
const EMAIL_FIELDS: Record<string, string> = {
  "/sign-in/magic-link": "email",
  "/change-email": "newEmail",
};

export const auth = betterAuth({
  database: db,
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL:
    siteHost && process.env.BETTER_AUTH_URL
      ? {
          allowedHosts: [new URL(process.env.BETTER_AUTH_URL).host, siteHost],
          protocol: "auto",
          // Server-side auth.api calls carry no request to resolve a host from.
          fallback: process.env.BETTER_AUTH_URL,
        }
      : process.env.BETTER_AUTH_URL ||
        (vercelHosts.length ? { allowedHosts: vercelHosts, protocol: "https" } : undefined),
  advanced: {
    cookiePrefix: process.env.TRIPWIRE_COOKIE_PREFIX,
    backgroundTasks: { handler: afterResponse },
  },
  trustedOrigins: vercelHosts.map((host) => `https://${host}`),
  rateLimit: {
    enabled: true,
    storage: "database",
    window: 60,
    max: 20,
    // Each request can mail someone else's inbox.
    customRules: { "/change-email": { window: 600, max: 3 } },
  },
  // The game is members-only. The anonymous plugin stays so existing guest sessions still resolve
  // (and are refused by player()) and can link to an account, but no new guest can sign in.
  // The email-change flow calls its verification sender directly; nothing needs it over HTTP.
  disabledPaths: ["/sign-in/anonymous", "/send-verification-email"],
  user: {
    additionalFields: {
      // Grant with SQL only: users can never set this through sign-up or profile updates.
      isAdmin: { type: "boolean", required: false, defaultValue: false, input: false },
      // Set only by /api/account/display-name, after validation and Jev's check.
      displayName: { type: "string", required: false, input: false },
    },
    // A link to the current inbox first, then one to the new inbox, so a stolen session alone
    // cannot move the account to another address.
    changeEmail: {
      enabled: true,
      sendChangeEmailConfirmation: async ({ user, newEmail, url }) =>
        sendEmail(
          user.email,
          "Confirm your Capture the flag email change",
          `Someone asked to change your Capture the flag email to ${newEmail}.\n\nOpen this link to confirm, and we'll send a link to the new address:\n\n${landing(url, "confirmed")}\n\n${IGNORE}`,
          "confirmation",
        ),
    },
  },
  emailVerification: {
    sendVerificationEmail: async ({ user, url }) =>
      sendEmail(
        user.email,
        "Verify your new Capture the flag email",
        `Open this link to make this your Capture the flag email:\n\n${landing(url, "changed")}\n\n${IGNORE}`,
        "confirmation",
      ),
  },
  // Magic links and email changes are the only ways an email reaches an account, so canonicalizing
  // here covers sign-up, sign-in, guest linking and changes. Runs before body validation: a
  // non-string is left for it to reject.
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path === "/change-email") {
        const session = await getSessionFromCtx(ctx);
        if (session && (session.user.isAnonymous || session.user.emailVerified !== true))
          throw new APIError("FORBIDDEN", { message: CHANGE_REFUSED });
        // Better Auth answers a taken address exactly like a new one and sends nothing, so the
        // player sees no difference. The server log records which it was, for support.
        if (session && typeof ctx.body?.newEmail === "string") {
          const {
            rows: [taken],
          } = await db.query<{ taken: boolean }>(
            `SELECT EXISTS(SELECT 1 FROM ctf."user" WHERE lower(email)=lower($1)) AS taken`,
            [canonicalEmail(ctx.body.newEmail)],
          );
          console.info(
            JSON.stringify({
              event: "auth.change_email.requested",
              userId: session.user.id,
              newAddressTaken: taken.taken,
            }),
          );
        }
      }
      const field = EMAIL_FIELDS[ctx.path];
      if (!field || typeof ctx.body?.[field] !== "string") return;
      return { context: { body: { ...ctx.body, [field]: canonicalEmail(ctx.body[field]) } } };
    }),
  },
  plugins: [
    anonymous({
      generateName: () => "Guest",
      onLinkAccount: async ({ anonymousUser, newUser }) => {
        await db.query("UPDATE ctf.games SET owner_id=$1 WHERE owner_id=$2", [
          newUser.user.id,
          anonymousUser.user.id,
        ]);
      },
    }),
    magicLink({
      storeToken: "hashed",
      sendMagicLink: ({ email, url }) =>
        sendEmail(
          email,
          "Your Capture the flag sign-in link",
          `Sign in to Capture the flag:\n\n${url}\n\nThis link expires in five minutes. ${IGNORE}`,
        ),
    }),
  ],
});
