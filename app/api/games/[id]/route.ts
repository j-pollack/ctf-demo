import { getPublicGameRow, publicGame, reconcileInference } from "@/lib/games";
import { errorResponse, player } from "@/lib/http";
export const runtime = "nodejs";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const id = (await params).id,
      user = await player(request);
    let game = await getPublicGameRow(id, user.id);
    if (Number(game.reserved_microdollars) > 0) {
      await reconcileInference(id);
      game = await getPublicGameRow(id, user.id);
    }
    return Response.json(await publicGame(game), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
