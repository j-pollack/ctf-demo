import { getGame, publicGame } from "@/lib/games";
import { errorResponse, player } from "@/lib/http";
export const runtime="nodejs";
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}) {
  try {return Response.json(await publicGame(await getGame((await params).id,(await player(request)).id)),{headers:{"Cache-Control":"no-store"}});} catch(error){return errorResponse(error);}
}
