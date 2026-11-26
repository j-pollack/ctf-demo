import { auth } from "@/lib/auth";
import { contactSender, parseFeedback, reportSender, saveFeedback } from "@/lib/feedback";
import { getPublicGameRow } from "@/lib/games";
import { body, checkOrigin, errorResponse, player } from "@/lib/http";
import { getSession } from "@/lib/sessions";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const feedback = parseFeedback(await body(request));
    if (feedback.kind === "contact") {
      // Signed-out visitors may write, so this reads the session without requiring one.
      const session = await auth.api.getSession({ headers: request.headers });
      const userId = session && !session.user.isAnonymous ? session.user.id : null;
      await saveFeedback(feedback, userId, contactSender(request.headers, secret()));
      return Response.json({ ok: true });
    }
    const user = await player(request);
    // Both lookups check that the run belongs to the caller.
    if (feedback.sessionId) await getSession(feedback.gameId, feedback.sessionId, user.id);
    else await getPublicGameRow(feedback.gameId, user.id);
    await saveFeedback(feedback, user.id, reportSender(user.id));
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}

function secret() {
  const value = process.env.BETTER_AUTH_SECRET;
  if (!value) throw new Error("BETTER_AUTH_SECRET is not set.");
  return value;
}
