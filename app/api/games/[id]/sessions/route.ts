import { createSession } from "@/lib/sessions";
import { getPublicGameRow, publicGame } from "@/lib/games";
import { body, checkOrigin, errorResponse, player } from "@/lib/http";
import { GameError } from "@/lib/policy";
import { getModel } from "@/lib/inference";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    checkOrigin(request);
    const user = await player(request);
    const data = await body(request);
    if (data.agentModel !== undefined && typeof data.agentModel !== "string")
      throw new GameError("Choose an agent model.");
    if (data.agentModel) await getModel(data.agentModel);
    if (
      data.agentEffort !== undefined &&
      !["low", "medium", "high"].includes(data.agentEffort as string)
    )
      throw new GameError("Choose an agent effort.");
    if (data.systemPrompt !== undefined && typeof data.systemPrompt !== "string")
      throw new GameError("Enter a valid system prompt.");
    const { id } = await params;
    await getPublicGameRow(id, user.id);
    const session = await createSession(id, user.id, {
      agentModel: data.agentModel as string | undefined,
      agentEffort: data.agentEffort as "low" | "medium" | "high" | undefined,
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
