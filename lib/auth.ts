import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { anonymous, magicLink } from "better-auth/plugins";
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
  advanced: { cookiePrefix: process.env.TRIPWIRE_COOKIE_PREFIX },
  trustedOrigins: vercelHosts.map((host) => `https://${host}`),
  rateLimit: { enabled: true, storage: "database", window: 60, max: 20 },
  // The game is members-only. The anonymous plugin stays so existing guest sessions still resolve
  // (and are refused by player()) and can link to an account, but no new guest can sign in.
  disabledPaths: ["/sign-in/anonymous"],
  // Grant with SQL only: users can never set this through sign-up or profile updates.
  user: {
    additionalFields: {
      isAdmin: { type: "boolean", required: false, defaultValue: false, input: false },
    },
  },
  // Magic links are the only way an email reaches an account, so canonicalizing here covers sign-up,
  // sign-in and guest linking. Runs before body validation: a non-string is left for it to reject.
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/sign-in/magic-link" || typeof ctx.body?.email !== "string") return;
      return { context: { body: { ...ctx.body, email: canonicalEmail(ctx.body.email) } } };
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
      sendMagicLink: async ({ email, url }) => {
        if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM)
          throw new Error("Email sign-in is not configured.");
        const result = await new Resend(process.env.RESEND_API_KEY).emails.send({
          from: process.env.RESEND_FROM,
          to: email,
          subject: "Your Capture the flag sign-in link",
          text: `Sign in to Capture the flag:\n\n${url}\n\nThis link expires in five minutes. If you didn't request it, ignore this email.`,
        });
        if (result.error) {
          const { status, message } = signInEmailError(result.error);
          // A plain Error becomes an empty 500; APIError carries the message to the player.
          throw new APIError(status, { message });
        }
      },
    }),
  ],
});
