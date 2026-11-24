import { errorResponse, player } from "@/lib/http";
import { monitorView } from "@/lib/monitor-view";
export const runtime = "nodejs";
// Owner only, and only once the run has ended: monitorView answers 404 and 409 otherwise.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await player(request);
    return Response.json(await monitorView((await params).id, user.id), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
