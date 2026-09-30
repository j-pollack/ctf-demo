import { randomUUID } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";
import type { PoolClient } from "pg";
import { db } from "./db";
import { AGENT_MODEL, MONITOR_MODEL, MONITOR_VERSION, MODELS, DAILY_CAP_MICRODOLLARS, GameError, makeSecret } from "./policy";
import type { GameEvent, GameStatus, PublicGame } from "./types";
import { createEnvironment, destroyEnvironment } from "./sprites";

export type GameRow = {
  id: string; owner_id: string; sprite_name: string; secret_hash: string;
  agent_model: string; monitor_model: string; status: GameStatus;
  token_budget: number; tokens_used: number; tokens_reserved: number;
  turns: number; blocks: number; messages: Message[];
  lease: string | null; lease_until: Date | null; sprite_deleted_at: Date | null;
};
export async function transaction<T>(fn: (client: PoolClient) => Promise<T>) {
  const client = await db.connect();
  try { await client.query("BEGIN"); const result = await fn(client); await client.query("COMMIT"); return result; }
  catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
export async function getGame(id: string, ownerId: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new GameError("Game not found.", 404);
  const { rows } = await db.query<GameRow>("SELECT * FROM ctf.games WHERE id=$1 AND owner_id=$2", [id, ownerId]);
  if (!rows[0]) throw new GameError("Game not found.", 404);
  return rows[0];
}
export async function publicGame(game: GameRow): Promise<PublicGame> {
  const { rows } = await db.query<{ id: string; data: Omit<GameEvent, "id"> }>("SELECT id,data FROM ctf.events WHERE game_id=$1 ORDER BY id", [game.id]);
  return {
    id: game.id, status: game.status, agentModel: game.agent_model, monitorModel: game.monitor_model,
    tokenBudget: game.token_budget, tokensUsed: game.tokens_used, turns: game.turns, blocks: game.blocks,
    busy: !!game.lease_until && new Date(game.lease_until).getTime() > Date.now(),
    events: rows.map(row => ({ ...row.data, id: Number(row.id) })),
  };
}
export async function assertLease(game: GameRow) {
  const result = await db.query("SELECT 1 FROM ctf.games WHERE id=$1 AND lease=$2 AND lease_until>now() AND status='active'", [game.id,game.lease]);
  if (!result.rowCount) throw new GameError("This response has stopped.",409);
}
export async function record(gameId: string, event: Omit<GameEvent, "id">, lease?: string | null) {
  const { rows } = await db.query(`INSERT INTO ctf.events(game_id,data) SELECT id,$2 FROM ctf.games
    WHERE id=$1 AND ($3::uuid IS NULL OR (lease=$3 AND lease_until>now())) RETURNING id`, [gameId, JSON.stringify(event),lease ?? null]);
  if (!rows[0]) throw new GameError("This response has stopped.",409);
  return { ...event, id: Number(rows[0].id) } as GameEvent;
}
export async function cleanup() {
  const pending = await db.query("SELECT id FROM ctf.inference WHERE settled_at IS NULL AND created_at<now()-interval '5 minutes' LIMIT 20");
  for (const call of pending.rows) await settleInference(call.id);
  await db.query("UPDATE ctf.games SET status='ended' WHERE status='creating' AND updated_at<now()-interval '5 minutes'");
  await db.query("UPDATE ctf.games SET status='ended',lease=NULL,lease_until=NULL WHERE status IN ('active','creating') AND updated_at < now()-interval '24 hours'");
  const { rows } = await db.query<GameRow>("SELECT * FROM ctf.games WHERE sprite_deleted_at IS NULL AND status IN ('captured','exhausted','ended') LIMIT 20");
  await Promise.all(rows.map(async game => {
    try {
      await destroyEnvironment(game.sprite_name);
      await db.query("UPDATE ctf.games SET sprite_deleted_at=now() WHERE id=$1", [game.id]);
    } catch { /* Keep the deletion pending for the next sweep. */ }
  }));
}
export async function startGame(ownerId: string, signedIn: boolean, agentModel: string = AGENT_MODEL, monitorModel: string = MONITOR_MODEL) {
  if (!MODELS.some(model => model === agentModel) || !MODELS.some(model => model === monitorModel)) throw new GameError("Unsupported model pairing.");
  await cleanup();
  const id = randomUUID();
  const { secret, hash } = makeSecret();
  const game = await transaction(async client => {
    // Serialize admission across instances so simultaneous starts cannot exceed the Sprite limit.
    await client.query("SELECT pg_advisory_xact_lock(713901)");
    const spend = await client.query("SELECT charged+reserved AS total FROM ctf.daily_spend WHERE day=(now() AT TIME ZONE 'UTC')::date");
    if (Number(spend.rows[0]?.total ?? 0) >= DAILY_CAP_MICRODOLLARS) throw new GameError("Today’s inference allowance is used up. Please return tomorrow.", 429);
    const existing = await client.query<GameRow>("SELECT * FROM ctf.games WHERE owner_id=$1 AND status IN ('creating','active')", [ownerId]);
    if (existing.rows.some(row => row.status==='creating' || (row.lease_until && new Date(row.lease_until).getTime() > Date.now()))) throw new GameError("Wait for the current game to finish starting or responding.", 409);
    const count = await client.query("SELECT count(*)::int AS total FROM ctf.games WHERE status IN ('creating','active') AND owner_id<>$1", [ownerId]);
    if (count.rows[0].total >= 10) throw new GameError("All game environments are busy. Please try again shortly.", 429);
    const starts = await client.query("SELECT count(*)::int AS total FROM ctf.games WHERE owner_id=$1 AND created_at > now()-interval '24 hours'", [ownerId]);
    if (starts.rows[0].total >= (signedIn ? 20 : 3)) throw new GameError("You’ve reached your daily new-game limit.", 429);
    const totalStarts=await client.query("SELECT count(*)::int AS total FROM ctf.games WHERE created_at>now()-interval '24 hours'");
    if (totalStarts.rows[0].total>=100) throw new GameError("Today’s new-game allowance is used up. Please return tomorrow.",429);
    await client.query("UPDATE ctf.games SET status='ended' WHERE owner_id=$1 AND status IN ('creating','active')", [ownerId]);
    const { rows } = await client.query<GameRow>(`INSERT INTO ctf.games(id,owner_id,sprite_name,secret_hash,agent_model,monitor_model,monitor_version,token_budget)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [id, ownerId, `ctf-${id}`, hash, agentModel, monitorModel, MONITOR_VERSION, signedIn ? 500000 : 100000]);
    return rows[0];
  });
  try {
    await createEnvironment(game.sprite_name, secret);
    await db.query("UPDATE ctf.games SET status='active',updated_at=now() WHERE id=$1", [id]);
    game.status = "active";
    await cleanup();
    return publicGame(game);
  } catch (error) {
    await db.query("UPDATE ctf.games SET status='ended' WHERE id=$1", [id]);
    await cleanup();
    throw error;
  }
}
export async function claimGame(id: string, ownerId: string) {
  await getGame(id, ownerId);
  const lease = randomUUID();
  const { rows } = await db.query<GameRow>(`UPDATE ctf.games SET lease=$3,lease_until=now()+interval '270 seconds',updated_at=now()
    WHERE id=$1 AND owner_id=$2 AND status='active' AND (lease_until IS NULL OR lease_until<now()) RETURNING *`, [id, ownerId, lease]);
  if (!rows[0]) throw new GameError("This game has ended or already has a response in progress.", 409);
  return rows[0];
}
export async function reserveInference(gameId: string, lease: string | null, role: "agent" | "monitor", model: string, input: number, wantedOutput: number, maxRate: number) {
  return transaction(async client => {
    const day = (await client.query("SELECT (now() AT TIME ZONE 'UTC')::date::text AS day")).rows[0].day as string;
    await client.query("INSERT INTO ctf.daily_spend(day) VALUES($1) ON CONFLICT DO NOTHING", [day]);
    const spend = (await client.query("SELECT * FROM ctf.daily_spend WHERE day=$1 FOR UPDATE", [day])).rows[0];
    const game = (await client.query<GameRow>("SELECT * FROM ctf.games WHERE id=$1 FOR UPDATE", [gameId])).rows[0];
    if (!game || game.status !== "active" || game.lease!==lease || !game.lease_until || new Date(game.lease_until).getTime()<=Date.now()) throw new GameError("This response has stopped.", 409);
    const maxTokens = Math.min(wantedOutput, game.token_budget-game.tokens_used-game.tokens_reserved-input);
    if (maxTokens < 64) throw new GameError("There isn’t enough token allowance for another response.", 402);
    const tokens = input+maxTokens;
    const cost = Math.ceil(tokens*maxRate*1_000_000);
    if (Number(spend.charged)+Number(spend.reserved)+cost > DAILY_CAP_MICRODOLLARS) throw new GameError("Today’s inference allowance is used up. Please return tomorrow.", 429);
    const id = randomUUID();
    await client.query("UPDATE ctf.daily_spend SET reserved=reserved+$2 WHERE day=$1", [day,cost]);
    await client.query("UPDATE ctf.games SET tokens_reserved=tokens_reserved+$2 WHERE id=$1", [gameId,tokens]);
    await client.query("INSERT INTO ctf.inference(id,game_id,day,role,model,token_ceiling,cost_ceiling) VALUES($1,$2,$3,$4,$5,$6,$7)", [id,gameId,day,role,model,tokens,cost]);
    return { id, maxTokens, tokens, cost };
  });
}
export async function settleInference(id: string, usage?: { tokens: number; cost: number; generationId?: string }) {
  await transaction(async client => {
    const call = (await client.query("SELECT * FROM ctf.inference WHERE id=$1 FOR UPDATE", [id])).rows[0];
    if (!call || call.settled_at) return;
    // Unknown usage after an interrupted request keeps the full reservation charged; no free retries.
    const tokens = usage ? Math.max(0,Math.ceil(usage.tokens)) : call.token_ceiling;
    const cost = usage ? Math.max(0,Math.ceil(usage.cost*1_000_000)) : Number(call.cost_ceiling);
    await client.query("UPDATE ctf.daily_spend SET reserved=reserved-$2,charged=charged+$3 WHERE day=$1", [call.day,call.cost_ceiling,cost]);
    await client.query("UPDATE ctf.games SET tokens_reserved=tokens_reserved-$2,tokens_used=tokens_used+$3 WHERE id=$1", [call.game_id,call.token_ceiling,tokens]);
    await client.query("UPDATE ctf.inference SET tokens=$2,cost=$3,generation_id=$4,settled_at=now() WHERE id=$1", [id,tokens,cost,usage?.generationId ?? null]);
  });
}
