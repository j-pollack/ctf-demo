import { getGame } from "@/lib/games";
import { getSession, requestSessionStop } from "@/lib/sessions";
import { checkOrigin, errorResponse, player } from "@/lib/http";
import { GameError } from "@/lib/policy";
export const runtime = "nodejs";
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; sessionId: string }> },
) {
  try {
    checkOrigin(request);
    const user = await player(request);
    const { id, sessionId } = await params;
    if (!/^[a-f0-9-]{36}$/i.test(sessionId)) throw new GameError("Choose a valid session.");
    const game = await getGame(id, user.id);
    await getSession(id, sessionId, user.id);
    if (game.monitor_mode !== "async")
      throw new GameError(
        "This run can only be stopped from the page that sent the instruction.",
        409,
      );
    return Response.json(
      { applied: await requestSessionStop(id, sessionId, user.id) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
