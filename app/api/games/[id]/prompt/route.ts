import { claimGame } from "@/lib/games";
import { body, checkOrigin, errorResponse, player } from "@/lib/http";
import { GameError } from "@/lib/policy";
import { runGame } from "@/lib/runner";
import { getModel } from "@/lib/inference";
export const runtime = "nodejs";
export const maxDuration = 300;
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    checkOrigin(request);
    const user = await player(request),
      data = await body(request);
    if (typeof data.prompt !== "string" || !data.prompt.trim() || data.prompt.length > 8192)
      throw new GameError("Enter an instruction of up to 8,192 characters.");
    if (data.agentModel !== undefined && typeof data.agentModel !== "string")
      throw new GameError("Choose an agent model.");
    if (typeof data.agentModel === "string") await getModel(data.agentModel, "agent");
    const game = await claimGame(
      (await params).id,
      user.id,
      data.agentModel as string | undefined,
      data.systemPrompt,
      {
        monitorModel: data.monitorModel,
        monitorDifficulty: data.monitorDifficulty,
        monitorReasoning: data.monitorReasoning,
      },
      data.agentEffort,
    );
    const cancel = new AbortController();
    const signal = AbortSignal.any([cancel.signal, request.signal, AbortSignal.timeout(230000)]);
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (type: string, data: unknown) => {
          try {
            controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
          } catch {
            cancel.abort();
          }
        };
        const heartbeat = setInterval(() => send("heartbeat", null), 15000);
        try {
          await runGame(game, data.prompt as string, signal, send);
        } catch {
          send("error", "This response was interrupted. Reload to recover your run.");
        } finally {
          clearInterval(heartbeat);
          try {
            controller.close();
          } catch {}
        }
      },
      cancel() {
        cancel.abort();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
