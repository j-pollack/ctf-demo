import { currentAgentModel } from "@/lib/agent-model";
import { createSession } from "@/lib/sessions";
import { getPublicGameRow, publicGame } from "@/lib/games";
import { body, checkOrigin, errorResponse, player } from "@/lib/http";
import { GameError, publicAgentSettings } from "@/lib/policy";
import { getModel } from "@/lib/inference";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    checkOrigin(request);
    const user = await player(request);
    const data = await body(request);
    const agent = publicAgentSettings(data, await currentAgentModel());
    if (data.systemPrompt !== undefined && typeof data.systemPrompt !== "string")
      throw new GameError("Enter a valid system prompt.");
    const { id } = await params;
    await getPublicGameRow(id, user.id);
    await getModel(agent.agentModel);
    const session = await createSession(id, user.id, {
      agentModel: agent.agentModel,
      agentEffort: agent.agentEffort,
      systemPrompt: data.systemPrompt as string | undefined,
    });
    const game = await getPublicGameRow(id, user.id);
    return Response.json(await publicGame(game, 0, session.id), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
