import { getPublicGameRow, publicGame, reconcileInference } from "@/lib/games";
import { errorResponse, player } from "@/lib/http";
import { GameError } from "@/lib/policy";
export const runtime = "nodejs";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const id = (await params).id,
      user = await player(request),
      after = new URL(request.url).searchParams.get("after") ?? "0";
    if (!/^\d{1,15}$/.test(after)) throw new GameError("Invalid event cursor.", 400);
    let game = await getPublicGameRow(id, user.id);
    if (Number(game.reserved_microdollars) > 0) {
      await reconcileInference(id);
      game = await getPublicGameRow(id, user.id);
    }
    return Response.json(await publicGame(game, Number(after)), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
