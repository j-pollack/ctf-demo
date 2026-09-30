import { randomUUID } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";
import type { PoolClient } from "pg";
import { db } from "./db";
import {
  AGENT_MODEL,
  MODELS,
  DAILY_CAP_MICRODOLLARS,
  GUEST_BUDGET_MICRODOLLARS,
  MEMBER_BUDGET_MICRODOLLARS,
  GameError,
  makeSecret,
} from "./policy";
import { currentSeason } from "./seasons";
import type { GameEvent, GameStatus, PublicGame } from "./types";
import { createEnvironment, destroyEnvironment } from "./sprites";

export type GameRow = {
  id: string;
  owner_id: string;
  sprite_name: string;
  secret_hash: string;
  agent_model: string;
  monitor_model: string;
  status: GameStatus;
  token_budget: number;
  tokens_used: number;
  tokens_reserved: number;
  budget_microdollars: number;
  spent_microdollars: number;
  reserved_microdollars: number;
  season_id: string;
  turns: number;
  blocks: number;
  messages: Message[];
  lease: string | null;
  lease_until: Date | null;
  sprite_deleted_at: Date | null;
};
export async function transaction<T>(fn: (client: PoolClient) => Promise<T>) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
export async function getGame(id: string, ownerId: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new GameError("Game not found.", 404);
  const { rows } = await db.query<GameRow>("SELECT * FROM ctf.games WHERE id=$1 AND owner_id=$2", [
    id,
    ownerId,
  ]);
  if (!rows[0]) throw new GameError("Game not found.", 404);
  return rows[0];
}
export async function publicGame(game: GameRow): Promise<PublicGame> {
  const { rows } = await db.query<{ id: string; data: Omit<GameEvent, "id"> }>(
    "SELECT id,data FROM ctf.events WHERE game_id=$1 ORDER BY id",
    [game.id],
  );
  const season = (await db.query("SELECT * FROM ctf.seasons WHERE id=$1", [game.season_id]))
    .rows[0];
  const spend = (
    await db.query(
      "SELECT role,coalesce(sum(cost),0) AS total FROM ctf.inference WHERE game_id=$1 AND settled_at IS NOT NULL GROUP BY role",
      [game.id],
    )
  ).rows;
  return {
    id: game.id,
    status: game.status,
    agentModel: game.agent_model,
    monitorModel: game.monitor_model,
    tokenBudget: game.token_budget,
    tokensUsed: game.tokens_used,
    turns: game.turns,
    blocks: game.blocks,
    budgetMicrodollars: Number(game.budget_microdollars),
    spentMicrodollars: Number(game.spent_microdollars),
    reservedMicrodollars: Number(game.reserved_microdollars),
    agentSpendMicrodollars: Number(spend.find((row) => row.role === "agent")?.total ?? 0),
    monitorSpendMicrodollars: Number(spend.find((row) => row.role === "monitor")?.total ?? 0),
    season: {
      id: season.id,
      name: season.name,
      startsAt: season.starts_at?.toISOString() ?? null,
      endsAt: season.ends_at?.toISOString() ?? null,
      monitorModel: season.monitor_model,
    },
    busy: !!game.lease_until && new Date(game.lease_until).getTime() > Date.now(),
    events: rows.map((row) => ({ ...row.data, id: Number(row.id) })),
  };
}
export async function assertLease(game: GameRow) {
  const result = await db.query(
    "SELECT 1 FROM ctf.games g JOIN ctf.seasons s ON s.id=g.season_id WHERE g.id=$1 AND lease=$2 AND lease_until>now() AND status='active' AND (s.ends_at IS NULL OR s.ends_at>now())",
    [game.id, game.lease],
  );
  if (!result.rowCount) throw new GameError("This response has stopped.", 409);
}
export async function record(gameId: string, event: Omit<GameEvent, "id">, lease?: string | null) {
  const { rows } = await db.query(
    `INSERT INTO ctf.events(game_id,data) SELECT id,$2 FROM ctf.games
    WHERE id=$1 AND ($3::uuid IS NULL OR (lease=$3 AND lease_until>now())) RETURNING id`,
    [gameId, JSON.stringify(event), lease ?? null],
  );
  if (!rows[0]) throw new GameError("This response has stopped.", 409);
  return { ...event, id: Number(rows[0].id) } as GameEvent;
}
export async function cleanup() {
  await reconcileInference();
  await db.query(
    "UPDATE ctf.games SET status='ended' WHERE status='creating' AND updated_at<now()-interval '5 minutes'",
  );
  await db.query(
    "UPDATE ctf.games SET status='ended',lease=NULL,lease_until=NULL WHERE status IN ('active','creating') AND updated_at < now()-interval '24 hours'",
  );
  await db.query(
    "UPDATE ctf.games g SET status='ended' FROM ctf.seasons s WHERE g.season_id=s.id AND s.ends_at<=now() AND g.status IN ('active','creating') AND (g.lease_until IS NULL OR g.lease_until<now())",
  );
  const { rows } = await db.query<GameRow>(
    "SELECT * FROM ctf.games WHERE sprite_deleted_at IS NULL AND status IN ('captured','exhausted','ended') LIMIT 20",
  );
  await Promise.all(
    rows.map(async (game) => {
      try {
        await destroyEnvironment(game.sprite_name);
        await db.query("UPDATE ctf.games SET sprite_deleted_at=now() WHERE id=$1", [game.id]);
      } catch {
        /* Keep the deletion pending for the next sweep. */
      }
    }),
  );
}
export async function startGame(
  ownerId: string,
  signedIn: boolean,
  agentModel: string = AGENT_MODEL,
) {
  if (!MODELS.some((model) => model === agentModel))
    throw new GameError("Unsupported attack model.");
  const season = await currentSeason();
  await cleanup();
  const id = randomUUID();
  const { secret, hash } = makeSecret();
  const game = await transaction(async (client) => {
    // Serialize admission across instances so simultaneous starts cannot exceed the Sprite limit.
    await client.query("SELECT pg_advisory_xact_lock(713901)");
    const spend = await client.query(
      "SELECT charged+reserved AS total FROM ctf.daily_spend WHERE day=(now() AT TIME ZONE 'UTC')::date",
    );
    if (Number(spend.rows[0]?.total ?? 0) >= DAILY_CAP_MICRODOLLARS)
      throw new GameError("Today’s inference allowance is used up. Please return tomorrow.", 429);
    const existing = await client.query<GameRow>(
      "SELECT * FROM ctf.games WHERE owner_id=$1 AND status IN ('creating','active')",
      [ownerId],
    );
    if (
      existing.rows.some(
        (row) =>
          row.status === "creating" ||
          (row.lease_until && new Date(row.lease_until).getTime() > Date.now()),
      )
    )
      throw new GameError("Wait for the current game to finish starting or responding.", 409);
    const count = await client.query(
      "SELECT count(*)::int AS total FROM ctf.games WHERE status IN ('creating','active') AND owner_id<>$1",
      [ownerId],
    );
    if (count.rows[0].total >= 10)
      throw new GameError("All game environments are busy. Please try again shortly.", 429);
    const starts = await client.query(
      "SELECT count(*)::int AS total FROM ctf.games WHERE owner_id=$1 AND created_at > now()-interval '24 hours'",
      [ownerId],
    );
    if (starts.rows[0].total >= (signedIn ? 20 : 3))
      throw new GameError("You’ve reached your daily new-game limit.", 429);
    const totalStarts = await client.query(
      "SELECT count(*)::int AS total FROM ctf.games WHERE created_at>now()-interval '24 hours'",
    );
    if (totalStarts.rows[0].total >= 100)
      throw new GameError("Today’s new-game allowance is used up. Please return tomorrow.", 429);
    await client.query(
      "UPDATE ctf.games SET status='ended' WHERE owner_id=$1 AND status IN ('creating','active')",
      [ownerId],
    );
    const { rows } = await client.query<GameRow>(
      `INSERT INTO ctf.games(id,owner_id,sprite_name,secret_hash,agent_model,monitor_model,monitor_version,token_budget,season_id,budget_microdollars)
      SELECT $1,$2,$3,$4,$5,monitor_model,monitor_version,$6,id,$7 FROM ctf.seasons WHERE id=$8 AND ends_at>now() RETURNING *`,
      [
        id,
        ownerId,
        `ctf-${id}`,
        hash,
        agentModel,
        signedIn ? 500000 : 100000,
        signedIn ? MEMBER_BUDGET_MICRODOLLARS : GUEST_BUDGET_MICRODOLLARS,
        season.id,
      ],
    );
    if (!rows[0]) throw new GameError("The season just ended. Start a new run.", 409);
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
export async function claimGame(id: string, ownerId: string, agentModel?: string) {
  if (agentModel !== undefined && !MODELS.includes(agentModel))
    throw new GameError("Unsupported attack model.");
  await getGame(id, ownerId);
  const lease = randomUUID();
  const { rows } = await db.query<GameRow>(
    `UPDATE ctf.games g SET lease=$3,lease_until=now()+interval '270 seconds',updated_at=now(),agent_model=coalesce($4,agent_model)
    FROM ctf.seasons s WHERE g.season_id=s.id AND g.id=$1 AND owner_id=$2 AND status='active' AND (lease_until IS NULL OR lease_until<now()) AND (s.ends_at IS NULL OR s.ends_at>now()) RETURNING g.*`,
    [id, ownerId, lease, agentModel ?? null],
  );
  if (!rows[0])
    throw new GameError("This game has ended or already has a response in progress.", 409);
  return rows[0];
}
export function requestAllowance(
  input: number,
  wantedOutput: number,
  inputRate: number,
  outputRate: number,
  available: number,
) {
  if (
    ![input, wantedOutput, inputRate, outputRate, available].every(Number.isFinite) ||
    input < 0 ||
    wantedOutput < 0 ||
    inputRate <= 0 ||
    outputRate <= 0
  )
    throw new Error("Invalid inference pricing or allowance.");
  // Cache writes can cost more than ordinary input. Reserve up to 2x input pricing.
  const inputCost = Math.ceil(input * inputRate * 2 * 1_000_000);
  let maxTokens = Math.min(
    wantedOutput,
    Math.floor((available - inputCost) / (outputRate * 1_000_000)),
  );
  if (maxTokens > 0 && inputCost + Math.ceil(maxTokens * outputRate * 1_000_000) > available)
    maxTokens--;
  return {
    maxTokens,
    cost: inputCost + Math.ceil(Math.max(0, maxTokens) * outputRate * 1_000_000),
  };
}
export async function reserveInference(
  gameId: string,
  lease: string | null,
  role: "agent" | "monitor",
  model: string,
  input: number,
  wantedOutput: number,
  inputRate: number,
  outputRate = inputRate,
) {
  return transaction(async (client) => {
    const day = (await client.query("SELECT (now() AT TIME ZONE 'UTC')::date::text AS day")).rows[0]
      .day as string;
    await client.query("INSERT INTO ctf.daily_spend(day) VALUES($1) ON CONFLICT DO NOTHING", [day]);
    const spend = (
      await client.query("SELECT * FROM ctf.daily_spend WHERE day=$1 FOR UPDATE", [day])
    ).rows[0];
    const game = (
      await client.query<GameRow>("SELECT * FROM ctf.games WHERE id=$1 FOR UPDATE", [gameId])
    ).rows[0];
    if (
      !game ||
      game.status !== "active" ||
      game.lease !== lease ||
      !game.lease_until ||
      new Date(game.lease_until).getTime() <= Date.now()
    )
      throw new GameError("This response has stopped.", 409);
    const season = (
      await client.query("SELECT ends_at FROM ctf.seasons WHERE id=$1", [game.season_id])
    ).rows[0];
    if (season.ends_at && new Date(season.ends_at).getTime() <= Date.now())
      throw new GameError("This season has ended. Start a new run.", 410);
    const available =
      Number(game.budget_microdollars) -
      Number(game.spent_microdollars) -
      Number(game.reserved_microdollars);
    const allowance = requestAllowance(input, wantedOutput, inputRate, outputRate, available);
    if (allowance.maxTokens < 64)
      throw new GameError(
        Number(game.reserved_microdollars) > 0
          ? "There isn’t enough available budget for this request. Some billing is still pending."
          : available <= 0
            ? "Your inference budget is exhausted."
            : "There isn’t enough budget for this request. Choose a cheaper attack model or start a new run.",
        available <= 0 && Number(game.reserved_microdollars) === 0 ? 402 : 400,
      );
    const globalAllowance = requestAllowance(
      input,
      allowance.maxTokens,
      inputRate,
      outputRate,
      DAILY_CAP_MICRODOLLARS - Number(spend.charged) - Number(spend.reserved),
    );
    if (globalAllowance.maxTokens < 64)
      throw new GameError("Today’s inference allowance is used up. Please return tomorrow.", 429);
    const { maxTokens, cost } = globalAllowance;
    const tokens = input + maxTokens;
    if (Number(spend.charged) + Number(spend.reserved) + cost > DAILY_CAP_MICRODOLLARS)
      throw new GameError("Today’s inference allowance is used up. Please return tomorrow.", 429);
    const id = randomUUID();
    await client.query("UPDATE ctf.daily_spend SET reserved=reserved+$2 WHERE day=$1", [day, cost]);
    await client.query(
      "UPDATE ctf.games SET tokens_reserved=tokens_reserved+$2,reserved_microdollars=reserved_microdollars+$3 WHERE id=$1",
      [gameId, tokens, cost],
    );
    await client.query(
      "INSERT INTO ctf.inference(id,game_id,day,role,model,token_ceiling,cost_ceiling) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [id, gameId, day, role, model, tokens, cost],
    );
    return { id, maxTokens, tokens, cost };
  });
}
export async function settleInference(
  id: string,
  usage?: { tokens: number; cost: number; generationId?: string },
) {
  // Unknown billing remains a pending hold, never a fabricated charge.
  if (!usage) return;
  if (
    !Number.isFinite(usage.tokens) ||
    usage.tokens < 0 ||
    !Number.isFinite(usage.cost) ||
    usage.cost < 0
  )
    throw new Error("Invalid inference usage.");
  await transaction(async (client) => {
    const call = (await client.query("SELECT * FROM ctf.inference WHERE id=$1 FOR UPDATE", [id]))
      .rows[0];
    if (!call || call.settled_at) return;
    const tokens = Math.ceil(usage.tokens);
    const cost = Math.ceil(usage.cost * 1_000_000);
    await client.query(
      "UPDATE ctf.daily_spend SET reserved=reserved-$2,charged=charged+$3 WHERE day=$1",
      [call.day, call.cost_ceiling, cost],
    );
    await client.query(
      "UPDATE ctf.games SET tokens_reserved=tokens_reserved-$2,tokens_used=tokens_used+$3,reserved_microdollars=reserved_microdollars-$4,spent_microdollars=spent_microdollars+$5 WHERE id=$1",
      [call.game_id, call.token_ceiling, tokens, call.cost_ceiling, cost],
    );
    await client.query(
      "UPDATE ctf.inference SET tokens=$2,cost=$3,generation_id=$4,settled_at=now() WHERE id=$1",
      [id, tokens, cost, usage?.generationId ?? null],
    );
  });
}
export async function reconcileInference(gameId?: string) {
  if (!process.env.OPENROUTER_API_KEY) return;
  const pending = await db.query(
    "SELECT id,generation_id FROM ctf.inference WHERE ($1::uuid IS NULL OR game_id=$1) AND settled_at IS NULL AND generation_id IS NOT NULL AND created_at<now()-interval '2 minutes' AND (reconciliation_attempted_at IS NULL OR reconciliation_attempted_at<now()-interval '5 minutes') ORDER BY created_at LIMIT 5",
    [gameId ?? null],
  );
  for (const call of pending.rows) {
    await db.query("UPDATE ctf.inference SET reconciliation_attempted_at=now() WHERE id=$1", [
      call.id,
    ]);
    try {
      const response = await fetch(
        `https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(call.generation_id)}`,
        {
          headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!response.ok) continue;
      const { data } = await response.json();
      if (!data.finish_reason && !data.cancelled) continue;
      const prompt = data.native_tokens_prompt ?? data.tokens_prompt,
        completion = data.native_tokens_completion ?? data.tokens_completion;
      if (typeof prompt !== "number" || typeof completion !== "number") continue;
      const tokens = prompt + completion;
      if (typeof data.total_cost === "number" && Number.isFinite(tokens))
        await settleInference(call.id, {
          tokens,
          cost: data.total_cost,
          generationId: call.generation_id,
        });
    } catch {
      /* Keep the hold and retry; never guess what a failed request cost. */
    }
  }
}
