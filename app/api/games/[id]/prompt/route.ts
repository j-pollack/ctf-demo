import { claimGameSession, getGame } from "@/lib/games";
import { getSession } from "@/lib/sessions";
import { body, checkOrigin, errorResponse, player } from "@/lib/http";
import { GameError, publicAgentSettings } from "@/lib/policy";
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
    const agent = publicAgentSettings(data);
    const gameId = (await params).id;
    if (
      data.sessionId !== undefined &&
      (typeof data.sessionId !== "string" || !/^[a-f0-9-]{36}$/i.test(data.sessionId))
    )
      throw new GameError("Choose a valid session.");
    await getGame(gameId, user.id);
    if (data.sessionId !== undefined) await getSession(gameId, data.sessionId as string, user.id);
    await getModel(agent.agentModel);
    const game = await claimGameSession(
      gameId,
      (data.sessionId as string | undefined) ?? gameId,
      user.id,
      agent.agentModel,
      data.systemPrompt,
      {
        monitorDifficulty: data.monitorDifficulty,
        monitorReasoning: data.monitorReasoning,
      },
      agent.agentEffort,
    );
    const cancel = new AbortController();
    const responseDeadline = AbortSignal.timeout(230000);
    const signal = AbortSignal.any([cancel.signal, request.signal, responseDeadline]);
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
          await runGame(game, data.prompt as string, signal, send, {
            deadlineSignal: responseDeadline,
          });
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
