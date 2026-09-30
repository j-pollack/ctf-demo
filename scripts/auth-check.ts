import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db } from "../lib/db";
import { auth } from "../lib/auth";
import { makeSecret, AGENT_MODEL, MONITOR_MODEL, MONITOR_VERSION } from "../lib/policy";
import { player } from "../lib/http";
import { GET as leaderboard } from "../app/api/leaderboard/route";

// Exercise the real auth handlers while capturing the outbound email locally.
const fetchOriginal=globalThis.fetch;
let link="";
globalThis.fetch=async (input,options)=>{
  if(String(input)==="https://api.resend.com/emails") {
    const email=JSON.parse(options!.body as string);
    link=email.text.match(/https?:\/\/\S+/)[0];
    return Response.json({id:randomUUID()});
  }
  return fetchOriginal(input,options);
};
const origin=process.env.BETTER_AUTH_URL!,id=randomUUID(),email=`ctf-auth-${id}@example.invalid`;
const userIds:string[]=[];
const cookies=(response:Response)=>response.headers.getSetCookie().map(cookie=>cookie.split(';')[0]).join('; ');
try {
  const guestResponse=await auth.handler(new Request(`${origin}/api/auth/sign-in/anonymous`,{method:"POST",headers:{origin,"Content-Type":"application/json"},body:"{}"}));
  assert.equal(guestResponse.status,200);
  const guest=await guestResponse.json();userIds.push(guest.user.id);
  const guestCookie=cookies(guestResponse);
  assert.equal((await player(new Request(origin,{headers:{cookie:guestCookie}}))).signedIn,false);
  await db.query(`INSERT INTO ctf.games(id,owner_id,sprite_name,secret_hash,agent_model,monitor_model,monitor_version,token_budget,status,sprite_deleted_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,100000,'active',now())`,[id,guest.user.id,`auth-check-${id}`,makeSecret().hash,AGENT_MODEL,MONITOR_MODEL,MONITOR_VERSION]);
  const sent=await auth.handler(new Request(`${origin}/api/auth/sign-in/magic-link`,{method:"POST",headers:{origin,cookie:guestCookie,"Content-Type":"application/json"},body:JSON.stringify({email,callbackURL:"/"})}));
  assert.equal(sent.status,200);
  assert.ok(link.startsWith(origin),"sign-in link must use the configured origin");
  const verified=await auth.handler(new Request(link,{headers:{cookie:guestCookie}}));
  assert.equal(verified.status,302);
  const member=await player(new Request(origin,{headers:{cookie:cookies(verified)}}));
  assert.equal(member.signedIn,true);userIds.push(member.id);
  const game=await db.query("SELECT owner_id,token_budget FROM ctf.games WHERE id=$1",[id]);
  assert.equal(game.rows[0].owner_id,member.id);
  assert.equal(game.rows[0].token_budget,500000);
  await db.query("UPDATE ctf.games SET status='captured',turns=2,tokens_used=100,blocks=1 WHERE id=$1",[id]);
  const board=await (await leaderboard(new Request(`${origin}/api/leaderboard`))).json();
  assert.ok(board.entries.some((entry:{turns:number;tokens:number})=>entry.turns===2 && entry.tokens===100));
  assert.ok(!JSON.stringify(board).includes(email));
  const replay=await auth.handler(new Request(link));
  assert.match(replay.headers.get("location")??"",/INVALID_TOKEN/);
  console.log("Passwordless verification, single-use links, guest-run transfer, 500k upgrade and private leaderboard entries passed. No email was sent.");
} finally {
  globalThis.fetch=fetchOriginal;
  await db.query("DELETE FROM ctf.games WHERE id=$1",[id]);
  await db.query('DELETE FROM ctf."user" WHERE id=ANY($1::text[]) OR email=$2',[userIds,email]);
  await db.end();
}
