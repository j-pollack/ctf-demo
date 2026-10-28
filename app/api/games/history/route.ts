import { db } from "@/lib/db";
import { errorResponse, player } from "@/lib/http";
import type { GameSummary } from "@/lib/types";

export const runtime = "nodejs";
const pageSize = (value: string | null) => {
  if (value === null) return 20;
  if (!/^[1-9]\d{0,2}$/.test(value) || Number(value) > 50)
    throw new Error("Invalid history limit.");
  return Number(value);
};
export async function GET(request: Request) {
  try {
    const user = await player(request),
      url = new URL(request.url);
    if (
      [...url.searchParams.keys()].some((key) => !["limit", "cursor"].includes(key)) ||
      ["limit", "cursor"].some((key) => url.searchParams.getAll(key).length > 1)
    )
      return Response.json({ error: "Invalid history query." }, { status: 400 });
    let limit: number;
    try {
      limit = pageSize(url.searchParams.get("limit"));
    } catch {
      return Response.json({ error: "Invalid history limit." }, { status: 400 });
    }
    const token = url.searchParams.get("cursor"),
      hasCursor = url.searchParams.has("cursor");
    let cursor: { createdAt: string; id: string } | undefined;
    if (hasCursor) {
      try {
        if (!token || token.length > 512) throw new Error();
        const value = Buffer.from(token, "base64url").toString(),
          parsed = JSON.parse(value);
        if (
          Buffer.from(token, "base64url").toString("base64url") !== token ||
          typeof parsed.createdAt !== "string" ||
          !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(parsed.createdAt) ||
          typeof parsed.id !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parsed.id)
        )
          throw new Error();
        const date = new Date(parsed.createdAt);
        if (
          parsed.createdAt.startsWith("0000-") ||
          date.toISOString().slice(0, 23) !== parsed.createdAt.slice(0, 23)
        )
          throw new Error();
        cursor = parsed;
      } catch {
        return Response.json({ error: "Invalid history cursor." }, { status: 400 });
      }
    }
    const result = await db.query(
      `
      SELECT g.id,g.status,g.agent_model,
        g.turns,g.blocks,g.budget_microdollars,g.spent_microdollars,g.reserved_microdollars,
        g.monitor_difficulty,to_char(g.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
      FROM ctf.games g
      WHERE g.owner_id=$1 AND ($2::timestamptz IS NULL OR (g.created_at,g.id)<($2,$3::uuid))
      ORDER BY g.created_at DESC,g.id DESC LIMIT $4`,
      [user.id, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
    );
    const more = result.rows.length > limit,
      rows = result.rows.slice(0, limit),
      last = rows.at(-1);
    const nextCursor =
      more && last
        ? Buffer.from(
            JSON.stringify({
              createdAt: last.created_at,
              id: last.id,
            }),
          ).toString("base64url")
        : null;
    const runs: GameSummary[] = rows.map((row) => ({
      id: row.id,
      status: row.status,
      agentModel: row.agent_model,
      monitorDifficulty: row.monitor_difficulty,
      turns: row.turns,
      blocks: row.blocks,
      budgetMicrodollars: Number(row.budget_microdollars),
      spentMicrodollars: Number(row.spent_microdollars),
      reservedMicrodollars: Number(row.reserved_microdollars),
      createdAt: row.created_at,
    }));
    return Response.json({ runs, nextCursor }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
