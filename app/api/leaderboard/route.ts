import { db } from "@/lib/db";
import { MODELS, MONITOR_VERSION } from "@/lib/policy";
import { errorResponse } from "@/lib/http";
import { createHash } from "node:crypto";
export async function GET(request:Request) {
  try {
    const params=new URL(request.url).searchParams;
    const agent=params.get("agent") ?? MODELS[0],monitor=params.get("monitor") ?? MODELS[1];
    if (!MODELS.some(m=>m===agent) || !MODELS.some(m=>m===monitor)) return Response.json({entries:[]});
    const result=await db.query(`WITH best AS (SELECT DISTINCT ON (g.owner_id) g.owner_id,g.turns,g.tokens_used AS tokens,g.blocks,g.updated_at AS captured_at
      FROM ctf.games g JOIN ctf."user" u ON u.id=g.owner_id
      WHERE g.status='captured' AND g.agent_model=$1 AND g.monitor_model=$2 AND g.monitor_version=$3 AND u."isAnonymous" IS NOT TRUE
      ORDER BY g.owner_id,g.turns,g.tokens_used,g.updated_at) SELECT * FROM best ORDER BY turns,tokens,captured_at LIMIT 50`,[agent,monitor,MONITOR_VERSION]);
    // Anonymous identity never exposes an email address on the public board.
    return Response.json({entries:result.rows.map(({owner_id,...entry})=>({...entry,name:`Operator ${createHash('sha256').update(owner_id).digest('hex').slice(0,6)}`}))},{headers:{"Cache-Control":"no-store"}});
  } catch(error){return errorResponse(error);}
}
