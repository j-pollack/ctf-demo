import { saveDisplayName } from "@/lib/display-name-check";
import { body, checkOrigin, errorResponse, player } from "@/lib/http";
export const runtime = "nodejs";
// The caller's own account only: the user comes from the session, never from the body.
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const user = await player(request);
    const data = await body(request);
    return Response.json({ displayName: await saveDisplayName(user.id, data.displayName) });
  } catch (error) {
    return errorResponse(error);
  }
}
