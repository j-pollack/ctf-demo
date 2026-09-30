import { currentSeason, listSeasons } from "@/lib/seasons";
import { errorResponse } from "@/lib/http";
export async function GET() {
  try {
    return Response.json(
      { current: await currentSeason(), seasons: await listSeasons() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
