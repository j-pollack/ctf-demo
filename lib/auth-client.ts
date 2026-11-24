import { createAuthClient } from "better-auth/react";
import {
  anonymousClient,
  inferAdditionalFields,
  magicLinkClient,
} from "better-auth/client/plugins";
import type { auth } from "./auth";

export const authClient = createAuthClient({
  plugins: [anonymousClient(), magicLinkClient(), inferAdditionalFields<typeof auth>()],
});
