import { currentAgentModel } from "@/lib/agent-model";
import { db } from "@/lib/db";
import { PUBLIC_GAME_COLUMNS, publicGame, startGame, type PublicGameRow } from "@/lib/games";
import { body, checkOrigin, errorResponse, player } from "@/lib/http";
import { publicAgentSettings } from "@/lib/policy";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function GET(request: Request) {
  try {
    const user = await player(request);
    const result = await db.query<PublicGameRow>(
      `SELECT ${PUBLIC_GAME_COLUMNS} FROM ctf.games WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 1`,
      [user.id],
    );
    return Response.json(
      { game: result.rows[0] ? await publicGame(result.rows[0]) : null },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const user = await player(request),
      data = await body(request);
    const agent = publicAgentSettings(data, await currentAgentModel());
    return Response.json(
      await startGame(user.id, agent.agentModel, {
        monitorDifficulty: data.monitorDifficulty,
        monitorReasoning: data.monitorReasoning,
        agentEffort: agent.agentEffort,
      }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
