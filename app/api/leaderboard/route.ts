import { db } from "@/lib/db";
import { MODELS, MONITOR_MODEL, MONITOR_VERSION } from "@/lib/policy";
import { MONITOR_DIFFICULTIES } from "@/lib/types";
import { errorResponse } from "@/lib/http";
import { createHash } from "node:crypto";
export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    // The board is per monitor model and difficulty (the monitor value is only ever a query
    // parameter, so an unknown one just matches no runs).
    const monitor = params.get("monitor") ?? MONITOR_MODEL,
      difficulty = params.get("difficulty") ?? "hard",
      // An empty agent is the "Any" filter, same as leaving it out.
      agent = params.get("agent") || null;
    if (
      !MONITOR_DIFFICULTIES.some((item) => item === difficulty) ||
      (agent && !MODELS.includes(agent))
    )
      return Response.json({ entries: [] });
    const result = await db.query(
      `WITH best AS (SELECT DISTINCT ON (g.owner_id) g.owner_id,g.turns,g.tokens_used AS tokens,g.spent_microdollars AS spend,g.blocks,g.monitor_reasoning,g.updated_at AS captured_at
      FROM ctf.games g JOIN ctf."user" u ON u.id=g.owner_id
      WHERE g.status='captured' AND g.monitor_model=$1 AND g.monitor_difficulty=$3 AND g.monitor_version=$4 AND g.reserved_microdollars=0 AND u."isAnonymous" IS NOT TRUE
        AND ($2::text IS NULL OR (g.agent_model=$2 AND NOT EXISTS(SELECT 1 FROM ctf.inference i WHERE i.game_id IN (WITH RECURSIVE lineage(id,parent) AS (SELECT g.id,g.forked_from UNION ALL SELECT p.id,p.forked_from FROM ctf.games p JOIN lineage l ON p.id=l.parent) SELECT id FROM lineage) AND i.role='agent' AND i.model<>$2)))
      ORDER BY g.owner_id,g.spent_microdollars,g.turns,g.updated_at) SELECT * FROM best ORDER BY spend,turns,captured_at LIMIT 50`,
      [monitor, agent, difficulty, MONITOR_VERSION],
    );
    // Anonymous identity never exposes an email address on the public board.
    return Response.json(
      {
        entries: result.rows.map(({ owner_id, ...entry }) => ({
          ...entry,
          spend: Number(entry.spend),
          name: `Player ${createHash("sha256").update(owner_id).digest("hex").slice(0, 6)}`,
        })),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
