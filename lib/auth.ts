import { betterAuth } from "better-auth";
import { anonymous, magicLink } from "better-auth/plugins";
import { Resend } from "resend";
import { db } from "./db";
import { MEMBER_BUDGET_MICRODOLLARS } from "./policy";

// Previews have no fixed origin: accept only this deployment's own Vercel hostnames.
const vercelHosts = [process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL].filter(
  (host): host is string => !!host,
);

export const auth = betterAuth({
  database: db,
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL:
    process.env.BETTER_AUTH_URL ||
    (vercelHosts.length ? { allowedHosts: vercelHosts, protocol: "https" } : undefined),
  advanced: { cookiePrefix: process.env.TRIPWIRE_COOKIE_PREFIX },
  trustedOrigins: vercelHosts.map((host) => `https://${host}`),
  rateLimit: { enabled: true, storage: "database", window: 60, max: 20 },
  plugins: [
    anonymous({
      generateName: () => "Guest",
      onLinkAccount: async ({ anonymousUser, newUser }) => {
        await db.query(
          "UPDATE ctf.games SET owner_id=$1,token_budget=CASE WHEN status='active' THEN 500000 ELSE token_budget END,budget_microdollars=CASE WHEN status='active' THEN $3 ELSE budget_microdollars END WHERE owner_id=$2",
          [newUser.user.id, anonymousUser.user.id, MEMBER_BUDGET_MICRODOLLARS],
        );
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
        if (result.error) throw new Error("Could not send your sign-in link. Please try again.");
      },
    }),
  ],
});
