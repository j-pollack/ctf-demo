import type { NextConfig } from "next";

const config: NextConfig = {
  serverExternalPackages: [
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-ai",
    "@fly/sprites",
    "pg",
  ],
  // The deployed commit, fixed at build time and visible to server and client components.
  env: { BUILD_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA ?? "" },
  // A submission path carries its one-time credential, so keep it out of the dev request log.
  logging: { incomingRequests: { ignore: [/^\/v1\/end\//] } },
};
export default config;
