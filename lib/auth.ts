import { betterAuth } from "better-auth";
import { anonymous, magicLink } from "better-auth/plugins";
import { Resend } from "resend";
import { db } from "./db";

export const auth = betterAuth({
  database: db,
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  trustedOrigins: process.env.VERCEL_URL ? [`https://${process.env.VERCEL_URL}`] : [],
  rateLimit: { enabled: true, storage: "database", window: 60, max: 20 },
  plugins: [
    anonymous({
      generateName: () => "Guest",
      onLinkAccount: async ({ anonymousUser, newUser }) => {
        await db.query("UPDATE ctf.games SET owner_id=$1,token_budget=CASE WHEN status='active' THEN 500000 ELSE token_budget END WHERE owner_id=$2", [newUser.user.id, anonymousUser.user.id]);
      },
    }),
    magicLink({
      storeToken: "hashed",
      sendMagicLink: async ({ email, url }) => {
        if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM) throw new Error("Email sign-in is not configured.");
        const result = await new Resend(process.env.RESEND_API_KEY).emails.send({
          from: process.env.RESEND_FROM,
          to: email,
          subject: "Your Tripwire sign-in link",
          text: `Sign in to Tripwire:\n\n${url}\n\nThis link expires in five minutes. If you didn't request it, ignore this email.`,
        });
        if (result.error) throw new Error("Could not send your sign-in link. Please try again.");
      },
    }),
  ],
});
