import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { db } from "../lib/db";
import { auth } from "../lib/auth";
import { makeSecret, AGENT_MODEL, MODELS, MONITOR_VERSION } from "../lib/policy";
import { player } from "../lib/http";
import { GET as leaderboard } from "../app/api/leaderboard/route";
import { currentSeason } from "../lib/seasons";

// Exercise the real auth handlers while capturing the outbound email locally.
const fetchOriginal = globalThis.fetch;
let link = "";
globalThis.fetch = async (input, options) => {
  if (String(input) === "https://api.resend.com/emails") {
    const email = JSON.parse(options!.body as string);
    link = email.text.match(/https?:\/\/\S+/)[0];
    return Response.json({ id: randomUUID() });
  }
  return fetchOriginal(input, options);
};
const origin = process.env.BETTER_AUTH_URL!,
  id = randomUUID(),
  email = `ctf-auth-${id}@example.invalid`;
const userIds: string[] = [];
const gameIds = [id],
  archiveId = `auth-check-${id}`;
const cookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
try {
  const guestResponse = await auth.handler(
    new Request(`${origin}/api/auth/sign-in/anonymous`, {
      method: "POST",
      headers: { origin, "Content-Type": "application/json" },
      body: "{}",
    }),
  );
  assert.equal(guestResponse.status, 200);
  const guest = await guestResponse.json();
  userIds.push(guest.user.id);
  const guestCookie = cookies(guestResponse);
  assert.equal(
    (await player(new Request(origin, { headers: { cookie: guestCookie } }))).signedIn,
    false,
  );
  const season = await currentSeason();
  await db.query(
    `INSERT INTO ctf.games(id,owner_id,sprite_name,secret_hash,agent_model,monitor_model,monitor_version,token_budget,status,sprite_deleted_at,season_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,100000,'active',now(),$8)`,
    [
      id,
      guest.user.id,
      `auth-check-${id}`,
      makeSecret().hash,
      AGENT_MODEL,
      season.monitorModel,
      MONITOR_VERSION,
      season.id,
    ],
  );
  const sent = await auth.handler(
    new Request(`${origin}/api/auth/sign-in/magic-link`, {
      method: "POST",
      headers: { origin, cookie: guestCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ email, callbackURL: "/" }),
    }),
  );
  assert.equal(sent.status, 200);
  assert.ok(link.startsWith(origin), "sign-in link must use the configured origin");
  const verified = await auth.handler(new Request(link, { headers: { cookie: guestCookie } }));
  assert.equal(verified.status, 302);
  const member = await player(new Request(origin, { headers: { cookie: cookies(verified) } }));
  assert.equal(member.signedIn, true);
  userIds.push(member.id);
  const game = await db.query(
    "SELECT owner_id,token_budget,budget_microdollars FROM ctf.games WHERE id=$1",
    [id],
  );
  assert.equal(game.rows[0].owner_id, member.id);
  assert.equal(game.rows[0].token_budget, 500000);
  assert.equal(Number(game.rows[0].budget_microdollars), 3000000);
  await db.query(
    "UPDATE ctf.games SET status='captured',turns=2,tokens_used=100,blocks=1,spent_microdollars=2000 WHERE id=$1",
    [id],
  );
  const board = await (await leaderboard(new Request(`${origin}/api/leaderboard`))).json();
  assert.ok(
    board.entries.some(
      (entry: { turns: number; tokens: number }) => entry.turns === 2 && entry.tokens === 100,
    ),
  );
  assert.ok(!JSON.stringify(board).includes(email));
  const cheaper = randomUUID(),
    pending = randomUUID(),
    archived = randomUUID();
  gameIds.push(cheaper, pending, archived);
  await db.query(
    "INSERT INTO ctf.seasons(id,name,monitor_model,monitor_version) VALUES($1,'Temporary archive check',$2,$3)",
    [archiveId, season.monitorModel, MONITOR_VERSION],
  );
  for (const [gameId, seasonId, turns, spend, reserved] of [
    [cheaper, season.id, 8, 1000, 0],
    [pending, season.id, 1, 0, 100],
    [archived, archiveId, 99, 500, 0],
  ] as const) {
    await db.query(
      `INSERT INTO ctf.games(id,owner_id,sprite_name,secret_hash,agent_model,monitor_model,monitor_version,token_budget,status,sprite_deleted_at,season_id,turns,spent_microdollars,reserved_microdollars)
      VALUES($1,$2,$3,$4,$5,$6,$7,500000,'captured',now(),$8,$9,$10,$11)`,
      [
        gameId,
        member.id,
        `auth-check-${gameId}`,
        makeSecret().hash,
        AGENT_MODEL,
        season.monitorModel,
        MONITOR_VERSION,
        seasonId,
        turns,
        spend,
        reserved,
      ],
    );
  }
  const operator = `Operator ${createHash("sha256").update(member.id).digest("hex").slice(0, 6)}`;
  const ranked = await (
    await leaderboard(new Request(`${origin}/api/leaderboard?season=${season.id}`))
  ).json();
  assert.equal(
    ranked.entries.find((entry: { name: string }) => entry.name === operator)?.turns,
    8,
    "cheapest settled capture wins, not the pending or fastest capture",
  );
  const archive = await (
    await leaderboard(new Request(`${origin}/api/leaderboard?season=${archiveId}`))
  ).json();
  assert.equal(
    archive.entries.find((entry: { name: string }) => entry.name === operator)?.turns,
    99,
    "historical seasons must stay separate",
  );
  await db.query(
    "INSERT INTO ctf.daily_spend(day) VALUES((now() AT TIME ZONE 'UTC')::date) ON CONFLICT DO NOTHING",
  );
  await db.query(
    `INSERT INTO ctf.inference(id,game_id,day,role,model,token_ceiling,cost_ceiling,tokens,cost,generation_id,settled_at)
    VALUES($1,$2,(now() AT TIME ZONE 'UTC')::date,'agent',$3,0,0,0,0,$4,now())`,
    [randomUUID(), cheaper, MODELS.find((model) => model !== AGENT_MODEL), `test-${id}`],
  );
  const fixed = await (
    await leaderboard(
      new Request(
        `${origin}/api/leaderboard?season=${season.id}&agent=${encodeURIComponent(AGENT_MODEL)}`,
      ),
    )
  ).json();
  assert.equal(
    fixed.entries.find((entry: { name: string }) => entry.name === operator)?.turns,
    2,
    "single-model comparisons must exclude mixed strategies",
  );
  const replay = await auth.handler(new Request(link));
  assert.match(replay.headers.get("location") ?? "", /INVALID_TOKEN/);
  console.log(
    "Passwordless verification, single-use links, guest-run transfer, $3 upgrade and private season leaderboard entries passed. No email was sent.",
  );
} finally {
  globalThis.fetch = fetchOriginal;
  await db.query("DELETE FROM ctf.inference WHERE game_id=ANY($1::uuid[])", [gameIds]);
  await db.query("DELETE FROM ctf.games WHERE id=ANY($1::uuid[])", [gameIds]);
  await db.query("DELETE FROM ctf.seasons WHERE id=$1", [archiveId]);
  await db.query('DELETE FROM ctf."user" WHERE id=ANY($1::text[]) OR email=$2', [userIds, email]);
  await db.end();
}
