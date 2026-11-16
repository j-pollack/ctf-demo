import type { NextConfig } from "next";

const config: NextConfig = {
  serverExternalPackages: [
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-ai",
    "@fly/sprites",
    "pg",
  ],
  // A submission path carries its one-time credential, so keep it out of the dev request log.
  logging: { incomingRequests: { ignore: [/^\/v1\/end\//] } },
};
export default config;
