import { timingSafeEqual } from "node:crypto";
import { cleanup } from "@/lib/games";
export const maxDuration=60;
export async function GET(request:Request) {
  const expected=process.env.CRON_SECRET ? `Bearer ${process.env.CRON_SECRET}` : "";
  const actual=request.headers.get("authorization") ?? "";
  if (!expected || Buffer.byteLength(actual)!==Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(actual),Buffer.from(expected))) return new Response("Unauthorized",{status:401});
  await cleanup();return Response.json({ok:true});
}
