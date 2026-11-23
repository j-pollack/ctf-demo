import { auth } from "./auth";
import { GameError } from "./policy";
export async function player(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  // Members only: guest sessions from before sign-in became required can't play.
  if (!session || session.user.isAnonymous) throw new GameError("Sign in to play.", 401);
  return { id: session.user.id };
}
export function checkOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const expected = new URL(request.url).origin;
  if (
    !origin ||
    (origin !== expected &&
      origin !== process.env.BETTER_AUTH_URL &&
      origin !== process.env.SITE_URL?.replace(/\/$/, "") &&
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
  let value: unknown;
  try {
    value = JSON.parse(text + decoder.decode());
  } catch {
    throw new GameError("Invalid request.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new GameError("Request body must be a JSON object.", 400);
  return value as Record<string, unknown>;
}
export function errorResponse(error: unknown) {
  return Response.json(
    {
      error:
        error instanceof GameError
          ? error.message
          : "The service could not complete this request. Try again.",
    },
    { status: error instanceof GameError ? error.status : 503 },
  );
}
