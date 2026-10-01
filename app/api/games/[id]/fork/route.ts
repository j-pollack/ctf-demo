import { startGame } from "@/lib/games";
import { body, checkOrigin, errorResponse, player } from "@/lib/http";
import { GameError } from "@/lib/policy";

export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    checkOrigin(request);
    const user = await player(request),
      data = await body(request);
    if (
      !data ||
      typeof data !== "object" ||
      Array.isArray(data) ||
      !Number.isSafeInteger(data.eventId) ||
      Number(data.eventId) <= 0
    )
      throw new GameError("Choose an agent response to fork.");
    const id = (await params).id;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
      throw new GameError("Game not found.", 404);
    return Response.json(
      await startGame(user.id, user.signedIn, undefined, {
        sourceId: id,
        eventId: Number(data.eventId),
      }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
