import { currentAgentModel } from "@/lib/agent-model";
import { startGame } from "@/lib/games";
import { body, checkOrigin, errorResponse, player } from "@/lib/http";
import { GameError, publicAgentSettings } from "@/lib/policy";

export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    checkOrigin(request);
    const user = await player(request);
    const agent = publicAgentSettings(
      request.body ? await body(request) : {},
      await currentAgentModel(),
    );
    const id = (await params).id;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
      throw new GameError("Run not found.", 404);
    return Response.json(
      await startGame(user.id, agent.agentModel, { sourceId: id, agentEffort: agent.agentEffort }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
