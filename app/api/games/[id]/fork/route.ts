import { startGame } from "@/lib/games";
import { checkOrigin, errorResponse, player } from "@/lib/http";
import { GameError } from "@/lib/policy";

export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    checkOrigin(request);
    const user = await player(request);
    const id = (await params).id;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
      throw new GameError("Run not found.", 404);
    return Response.json(await startGame(user.id, undefined, { sourceId: id }));
  } catch (error) {
    return errorResponse(error);
  }
}
