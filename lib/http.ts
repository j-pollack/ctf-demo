import { auth } from "./auth";
import { GameError } from "./policy";
export async function player(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) throw new GameError("Sign in or play as a guest.", 401);
  return { id: session.user.id, signedIn: !session.user.isAnonymous };
}
export function checkOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const expected = new URL(request.url).origin;
  if (
    !origin ||
    (origin !== expected &&
      origin !== process.env.BETTER_AUTH_URL &&
      origin !== `https://${process.env.VERCEL_URL}`)
  )
    throw new GameError("Request origin is not allowed.", 403);
}
export async function body(request: Request) {
  if (Number(request.headers.get("content-length") ?? 0) > 20000)
    throw new GameError("Instruction is too long.", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new GameError("A request body is required.");
  let text = "",
    size = 0;
  const decoder = new TextDecoder();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > 20000) {
      await reader.cancel();
      throw new GameError("Instruction is too long.", 413);
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  try {
    return JSON.parse(text + decoder.decode()) as Record<string, unknown>;
  } catch {
    throw new GameError("Invalid request.");
  }
}
export function errorResponse(error: unknown) {
  return Response.json(
    {
      error:
        error instanceof GameError
          ? error.message
          : "The service could not complete this request. Please try again.",
    },
    { status: error instanceof GameError ? error.status : 503 },
  );
}
