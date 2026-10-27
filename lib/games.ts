import { randomUUID } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";
import type { PoolClient } from "pg";
import { db } from "./db";
import { MONITOR_TOKEN_MICRODOLLARS, MONITOR_VERSION } from "./control";
import { AGENT_MODEL, MODELS, DAILY_CAP_MICRODOLLARS, GameError, makeSecret } from "./policy";
import { TYPESAFE_MODEL } from "./typesafe";
import {
  AGENT_EFFORTS,
  MONITOR_DIFFICULTIES,
  RUN_BUDGET_MICRODOLLARS,
  RUNS_PER_DAY,
  type AgentEffort,
  type GameEvent,
  type GameStatus,
  type MonitorDifficulty,
  type PublicGame,
} from "./types";
import { createEnvironment, destroyEnvironment, restoreEnvironment } from "./sprites";
import { forkBeforeLastInstruction } from "./fork-transcript";

export type GameRow = {
  id: string;
  owner_id: string;
  sprite_name: string;
  secret_hash: string;
  agent_model: string;
  agent_effort: AgentEffort;
  monitor_model: string;
  monitor_version: string;
  monitor_difficulty: MonitorDifficulty;
  system_prompt: string;
  status: GameStatus;
  token_budget: number;
  tokens_used: number;
  tokens_reserved: number;
  budget_microdollars: number;
  spent_microdollars: number;
  reserved_microdollars: number;
  turns: number;
  blocks: number;
  messages: Message[];
  lease: string | null;
  lease_until: Date | null;
  sprite_deleted_at: Date | null;
  updated_at: Date;
  forked_from: string | null;
  monitor_reasoning: boolean;
};
// A blocked or caught run's environment is kept this long so its owner can fork it (cleanup adds a margin).
const FORK_WINDOW_MS = 24 * 60 * 60 * 1000;
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
// Everything publicGame reads. Excludes `messages`, the full transcript, which polled reads
// would otherwise re-download on every request.
export const PUBLIC_GAME_COLUMNS =
  "id,status,agent_model,agent_effort,system_prompt,token_budget,tokens_used,turns,blocks,budget_microdollars,spent_microdollars,reserved_microdollars,monitor_difficulty,lease_until,monitor_reasoning,sprite_deleted_at,updated_at";
export type PublicGameRow = Pick<
  GameRow,
  | "id"
  | "status"
  | "agent_model"
  | "agent_effort"
  | "system_prompt"
  | "token_budget"
  | "tokens_used"
  | "turns"
  | "blocks"
  | "budget_microdollars"
  | "spent_microdollars"
  | "reserved_microdollars"
  | "monitor_difficulty"
  | "lease_until"
  | "monitor_reasoning"
  | "sprite_deleted_at"
  | "updated_at"
>;
export async function getGame(id: string, ownerId: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new GameError("Run not found.", 404);
  const { rows } = await db.query<GameRow>("SELECT * FROM ctf.games WHERE id=$1 AND owner_id=$2", [
    id,
    ownerId,
  ]);
  if (!rows[0]) throw new GameError("Run not found.", 404);
  return rows[0];
}
export async function getPublicGameRow(id: string, ownerId: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new GameError("Run not found.", 404);
  const { rows } = await db.query<PublicGameRow>(
    `SELECT ${PUBLIC_GAME_COLUMNS} FROM ctf.games WHERE id=$1 AND owner_id=$2`,
    [id, ownerId],
  );
  if (!rows[0]) throw new GameError("Run not found.", 404);
  return rows[0];
}
// One read of a run's money, shared by publicGame and the runner's live `billing` frames.
export async function gameBilling(gameId: string) {
  // A fork inherits its parent's spend, so the agent/monitor split sums the whole lineage.
  const { rows } = await db.query(
    `WITH RECURSIVE lineage(id,parent) AS (
      SELECT id,forked_from FROM ctf.games WHERE id=$1
      UNION ALL SELECT g.id,g.forked_from FROM ctf.games g JOIN lineage l ON g.id=l.parent)
    SELECT g.budget_microdollars,g.spent_microdollars,g.reserved_microdollars,
      coalesce(sum(i.cost) FILTER (WHERE i.role='agent'),0) AS agent,
      coalesce(sum(i.cost) FILTER (WHERE i.role='monitor'),0) AS monitor
    FROM ctf.games g LEFT JOIN ctf.inference i ON i.game_id IN (SELECT id FROM lineage) AND i.settled_at IS NOT NULL
    WHERE g.id=$1 GROUP BY g.id`,
    [gameId],
  );
  const row = rows[0];
  return {
    budgetMicrodollars: Number(row.budget_microdollars),
    spentMicrodollars: Number(row.spent_microdollars),
    reservedMicrodollars: Number(row.reserved_microdollars),
    agentSpendMicrodollars: Number(row.agent),
    monitorSpendMicrodollars: Number(row.monitor),
  };
}
// afterEventId > 0 returns only newer events, so pollers re-download nothing they already hold.
// Safe because each run has one writer (its lease) and the runner records events sequentially.
export async function publicGame(game: PublicGameRow, afterEventId = 0): Promise<PublicGame> {
  const { rows } = await db.query<{ id: string; data: Omit<GameEvent, "id"> }>(
    "SELECT id,data FROM ctf.events WHERE game_id=$1 AND id>$2 ORDER BY id",
    [game.id, afterEventId],
  );
  const billing = await gameBilling(game.id);
  const forked = (await db.query("SELECT 1 FROM ctf.games WHERE forked_from=$1", [game.id]))
    .rowCount;
  const checkpointed =
    (game.status === "blocked" || game.status === "caught") &&
    !!(
      await db.query(
        "SELECT data->>'checkpoint' AS checkpoint FROM ctf.events WHERE game_id=$1 AND data->>'kind'='user' ORDER BY id DESC LIMIT 1",
        [game.id],
      )
    ).rows[0]?.checkpoint;
  const busy = !!game.lease_until && new Date(game.lease_until).getTime() > Date.now();
  return {
    id: game.id,
    status: game.status,
    agentModel: game.agent_model,
    agentEffort: game.agent_effort,
    monitorDifficulty: game.monitor_difficulty,
    systemPrompt: game.system_prompt,
    tokenBudget: game.token_budget,
    tokensUsed: game.tokens_used,
    turns: game.turns,
    blocks: game.blocks,
    monitorReasoning: game.monitor_reasoning,
    forkable:
      (game.status === "blocked" || game.status === "caught") &&
      !forked &&
      checkpointed &&
      !busy &&
      !game.sprite_deleted_at &&
      Date.now() - new Date(game.updated_at).getTime() < FORK_WINDOW_MS,
    ...billing,
    busy,
    events: rows.map((row) => ({ ...row.data, id: Number(row.id) })),
  };
}
export async function assertLease(game: GameRow) {
  const result = await db.query(
    "SELECT 1 FROM ctf.games WHERE id=$1 AND lease=$2 AND lease_until>now() AND status='active'",
    [game.id, game.lease],
  );
  if (!result.rowCount) throw new GameError("This response has stopped.", 409);
}
export async function record(gameId: string, event: Omit<GameEvent, "id">, lease?: string | null) {
  const { rows } = await db.query(
    `INSERT INTO ctf.events(game_id,data) SELECT id,$2 FROM ctf.games
    WHERE id=$1 AND ($3::uuid IS NULL OR (lease=$3 AND lease_until>now())) FOR UPDATE RETURNING id`,
    [gameId, JSON.stringify(event), lease ?? null],
  );
  if (!rows[0]) throw new GameError("This response has stopped.", 409);
  return { ...event, id: Number(rows[0].id) } as GameEvent;
}
export async function cleanup() {
  await reconcileInference();
  await expireUnverifiableHolds();
  // A fork child stuck in `creating` never ran: delete it so its parent can be forked again.
  await transaction(async (client) => {
    const stuck =
      "status='creating' AND forked_from IS NOT NULL AND updated_at<now()-interval '5 minutes'";
    await client.query(
      `DELETE FROM ctf.events WHERE game_id IN (SELECT id FROM ctf.games WHERE ${stuck})`,
    );
    await client.query(`DELETE FROM ctf.games WHERE ${stuck}`);
  });
  await db.query(
    "UPDATE ctf.games SET status='ended' WHERE status='creating' AND updated_at<now()-interval '5 minutes'",
  );
  await db.query(
    "UPDATE ctf.games SET status='ended',lease=NULL,lease_until=NULL WHERE status IN ('active','creating') AND updated_at < now()-interval '24 hours'",
  );
  // Forks share their parent's sprite: destroy it once, when every run on it is done. A blocked or
  // caught run is done once forked, or after 25h (the fork window plus a margin so cleanup cannot race a fork).
  const { rows } = await db.query<{ sprite_name: string }>(
    `SELECT g.sprite_name FROM ctf.games g
    WHERE g.sprite_name IN (SELECT sprite_name FROM ctf.games WHERE sprite_deleted_at IS NULL)
    GROUP BY g.sprite_name
    HAVING bool_or(g.sprite_deleted_at IS NULL) AND bool_and(g.status IN ('captured','exhausted','ended')
      OR (g.status IN ('blocked','caught') AND (g.updated_at<now()-interval '25 hours'
        OR EXISTS(SELECT 1 FROM ctf.games c WHERE c.forked_from=g.id)))) LIMIT 20`,
  );
  await Promise.all(
    rows.map(async ({ sprite_name }) => {
      try {
        await destroyEnvironment(sprite_name);
        await db.query(
          "UPDATE ctf.games SET sprite_deleted_at=now() WHERE sprite_name=$1 AND sprite_deleted_at IS NULL",
          [sprite_name],
        );
      } catch {
        /* Keep the deletion pending for the next sweep. */
      }
    }),
  );
}
export type MonitorOptions = {
  monitorDifficulty?: unknown;
  monitorReasoning?: unknown;
};
// The one validator for a player's monitor choice (new run and first instruction). Fields the
// player did not send stay undefined so each caller can apply its own default. Nothing here touches
// the database, so a rejection never takes a lease or creates a run.
export function checkMonitor(options: MonitorOptions) {
  const { monitorDifficulty: difficulty, monitorReasoning: reasoning } = options;
  if (difficulty !== undefined && !MONITOR_DIFFICULTIES.some((item) => item === difficulty))
    throw new GameError("Choose a monitor difficulty: easy, medium or hard.");
  if (reasoning !== undefined && typeof reasoning !== "boolean")
    throw new GameError("monitorReasoning must be true or false.");
  return {
    difficulty: difficulty as MonitorDifficulty | undefined,
    reasoning: reasoning as boolean | undefined,
  };
}
// A player's agent effort; undefined stays undefined so each caller applies its own default.
function checkEffort(effort: unknown) {
  if (effort !== undefined && !AGENT_EFFORTS.some((item) => item === effort))
    throw new GameError("Choose an agent effort.", 400);
  return effort as AgentEffort | undefined;
}
export async function startGame(
  ownerId: string,
  agentModel: string = AGENT_MODEL,
  options: MonitorOptions & { sourceId?: string; agentEffort?: unknown } = {},
) {
  const { sourceId } = options;
  if (sourceId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sourceId))
    throw new GameError("Run not found.", 404);
  if (!MODELS.some((model) => model === agentModel))
    throw new GameError("Unsupported agent model.");
  const effort = checkEffort(options.agentEffort);
  // Before cleanup and admission: a bad choice must neither create a run nor end the current one.
  const monitor = checkMonitor(options);
  await cleanup();
  // cleanup() reconciles resolvable holds; for a fork, finalize any that remain on the terminal
  // source run (e.g. a disconnected agent call) so the fork isn't blocked on billing that would
  // otherwise clear only via the 24h sweep.
  if (sourceId) {
    const src = (
      await db.query<{ owner_id: string; status: string; reserved_microdollars: string }>(
        "SELECT owner_id,status,reserved_microdollars FROM ctf.games WHERE id=$1",
        [sourceId],
      )
    ).rows[0];
    if (
      src?.owner_id === ownerId &&
      (src.status === "blocked" || src.status === "caught") &&
      Number(src.reserved_microdollars) > 0
    )
      await finalizeHolds(sourceId);
  }
  const id = randomUUID();
  const { secret, hash } = makeSecret();
  const game = await transaction(async (client) => {
    // Serialize admission across instances so simultaneous starts cannot exceed the Sprite limit.
    await client.query("SELECT pg_advisory_xact_lock(713901)");
    const spend = await client.query(
      "SELECT charged+reserved AS total FROM ctf.daily_spend WHERE day=(now() AT TIME ZONE 'UTC')::date",
    );
    if (Number(spend.rows[0]?.total ?? 0) >= DAILY_CAP_MICRODOLLARS)
      throw new GameError(
        "Today’s shared inference budget is used up. Come back tomorrow (UTC).",
        429,
      );
    const existing = await client.query<GameRow>(
      "SELECT * FROM ctf.games WHERE owner_id=$1 AND status IN ('creating','active') FOR UPDATE",
      [ownerId],
    );
    if (
      existing.rows.some(
        (row) =>
          row.status === "creating" ||
          (row.lease_until && new Date(row.lease_until).getTime() > Date.now()),
      )
    )
      throw new GameError("Wait for your current run to finish starting or responding.", 409);
    const count = await client.query(
      "SELECT count(*)::int AS total FROM ctf.games WHERE status IN ('creating','active') AND owner_id<>$1",
      [ownerId],
    );
    if (count.rows[0].total >= 10)
      throw new GameError("All environments are busy. Try again in a few minutes.", 429);
    // A fork reuses its parent's sprite, so it takes no new-run quota.
    const starts = await client.query(
      "SELECT count(*)::int AS total FROM ctf.games WHERE owner_id=$1 AND forked_from IS NULL AND created_at > now()-interval '24 hours'",
      [ownerId],
    );
    if (!sourceId && starts.rows[0].total >= RUNS_PER_DAY)
      throw new GameError("You’ve reached your daily limit of new runs.", 429);
    const totalStarts = await client.query(
      "SELECT count(*)::int AS total FROM ctf.games WHERE forked_from IS NULL AND created_at>now()-interval '24 hours'",
    );
    if (!sourceId && totalStarts.rows[0].total >= 100)
      throw new GameError("No more new runs can start today. Come back tomorrow (UTC).", 429);
    let source: GameRow | undefined;
    let cut: ReturnType<typeof forkBeforeLastInstruction> | undefined;
    if (sourceId) {
      // Every check runs before the owner's other runs are ended.
      source = (
        await client.query<GameRow>(
          "SELECT * FROM ctf.games WHERE id=$1 AND owner_id=$2 FOR UPDATE",
          [sourceId, ownerId],
        )
      ).rows[0];
      if (!source) throw new GameError("Run not found.", 404);
      if (source.status !== "blocked" && source.status !== "caught")
        throw new GameError("Only a run the monitor stopped can be forked.", 409);
      if ((await client.query("SELECT 1 FROM ctf.games WHERE forked_from=$1", [sourceId])).rowCount)
        throw new GameError("This run has already been forked.", 409);
      if (
        source.sprite_deleted_at ||
        Date.now() - new Date(source.updated_at).getTime() >= FORK_WINDOW_MS
      )
        throw new GameError("This run’s environment is gone, so it can’t be forked.", 410);
      if (source.lease_until && new Date(source.lease_until).getTime() > Date.now())
        throw new GameError("Wait for the current response to finish before forking.", 409);
      if (Number(source.reserved_microdollars) > 0)
        throw new GameError("Billing is still settling; try again shortly.", 409);
      try {
        const history = (
          await client.query<{ id: string; data: GameEvent }>(
            "SELECT id,data FROM ctf.events WHERE game_id=$1 ORDER BY id",
            [source.id],
          )
        ).rows.map((row) => ({ ...row.data, id: Number(row.id) }));
        cut = forkBeforeLastInstruction(source.messages, history);
      } catch {
        throw new GameError("This run can’t be safely forked.", 409);
      }
    }
    await client.query(
      "UPDATE ctf.games SET status='ended',lease=NULL,lease_until=NULL WHERE owner_id=$1 AND status IN ('creating','active')",
      [ownerId],
    );
    // A fork is born `creating` on its parent's sprite and secret, carrying the parent's whole
    // account; it turns active once the sprite is restored to the dropped instruction's checkpoint.
    const { rows } = await client.query<GameRow>(
      `INSERT INTO ctf.games(id,owner_id,sprite_name,secret_hash,agent_model,monitor_model,monitor_difficulty,monitor_version,token_budget,budget_microdollars,system_prompt,monitor_reasoning,status,forked_from,messages,turns,blocks,tokens_used,spent_microdollars,agent_effort)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
      [
        id,
        ownerId,
        source?.sprite_name ?? `ctf-${id}`,
        source?.secret_hash ?? hash,
        source?.agent_model ?? agentModel,
        TYPESAFE_MODEL,
        source?.monitor_difficulty ?? monitor.difficulty ?? "hard",
        MONITOR_VERSION,
        source?.token_budget ?? 500000,
        source?.budget_microdollars ?? RUN_BUDGET_MICRODOLLARS,
        source?.system_prompt ?? "",
        source?.monitor_reasoning ?? monitor.reasoning ?? true,
        "creating",
        source?.id ?? null,
        JSON.stringify(cut?.messages ?? []),
        source?.turns ?? 0,
        // A fork is a fresh attempt: it starts with no blocks, while spend and turns carry over.
        0,
        source?.tokens_used ?? 0,
        source?.spent_microdollars ?? 0,
        source?.agent_effort ?? effort ?? "medium",
      ],
    );
    // The player-visible history up to the dropped instruction is copied as it was.
    if (source && cut)
      await client.query(
        "INSERT INTO ctf.events(game_id,data) SELECT $1,data FROM ctf.events WHERE game_id=$2 AND id<$3 ORDER BY id",
        [id, source.id, cut.userEventId],
      );
    return { ...rows[0], cut };
  });
  if (game.cut) {
    const { cut, ...child } = game;
    try {
      await restoreEnvironment(child.sprite_name, cut.checkpoint);
    } catch (error) {
      // The child never ran and has no inference; remove it so the parent can be forked again.
      await transaction(async (client) => {
        await client.query("DELETE FROM ctf.events WHERE game_id=$1", [id]);
        await client.query("DELETE FROM ctf.games WHERE id=$1 AND status='creating'", [id]);
      });
      console.error(
        JSON.stringify({
          event: "fork.restore.failed",
          timestamp: new Date().toISOString(),
          gameId: id,
          error: String(error instanceof Error ? error.message : error).slice(0, 300),
        }),
      );
      throw new GameError(
        "Could not restore the environment, so the run was not forked. Try again.",
        503,
      );
    }
    await db.query("UPDATE ctf.games SET status='active',updated_at=now() WHERE id=$1", [id]);
    child.status = "active";
    await cleanup();
    return { ...(await publicGame(child)), retryInstruction: cut.instruction };
  }
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
export async function claimGame(
  id: string,
  ownerId: string,
  agentModel?: string,
  systemPrompt?: unknown,
  monitorOptions: MonitorOptions = {},
  agentEffort?: unknown,
) {
  const effort = checkEffort(agentEffort);
  if (agentModel !== undefined && !MODELS.includes(agentModel))
    throw new GameError("Unsupported agent model.");
  if (
    systemPrompt !== undefined &&
    (typeof systemPrompt !== "string" || systemPrompt.length > 8192)
  )
    throw new GameError("Enter a system prompt of up to 8,192 characters.");
  const monitor = checkMonitor(monitorOptions);
  await getGame(id, ownerId);
  const lease = randomUUID();
  // The monitor choice only applies until the run's first instruction was recorded; afterwards the
  // fields are ignored. Same statement as the lease, so a rejected choice never takes one.
  const open =
    "NOT EXISTS(SELECT 1 FROM ctf.events e WHERE e.game_id=g.id AND e.data->>'kind'='user')";
  const { rows } = await db.query<GameRow>(
    `UPDATE ctf.games g SET lease=$3,lease_until=now()+interval '270 seconds',updated_at=now(),agent_model=coalesce($4,agent_model),agent_effort=coalesce($8,agent_effort),system_prompt=coalesce($5,system_prompt),
      monitor_difficulty=CASE WHEN $6::text IS NOT NULL AND ${open} THEN $6 ELSE monitor_difficulty END,
      monitor_reasoning=CASE WHEN $7::boolean IS NOT NULL AND ${open} THEN $7 ELSE monitor_reasoning END
    WHERE g.id=$1 AND owner_id=$2 AND status='active' AND (lease_until IS NULL OR lease_until<now()) RETURNING g.*`,
    [
      id,
      ownerId,
      lease,
      agentModel ?? null,
      systemPrompt === undefined ? null : systemPrompt.trim() ? systemPrompt : "",
      monitor.difficulty ?? null,
      monitor.reasoning ?? null,
      effort ?? null,
    ],
  );
  if (!rows[0]) throw new GameError("This run has ended or is already responding.", 409);
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
            : "There isn’t enough budget for this request. Choose a cheaper agent model or start a new run.",
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
      throw new GameError(
        "Today’s shared inference budget is used up. Come back tomorrow (UTC).",
        429,
      );
    const { maxTokens, cost } = globalAllowance;
    const tokens = input + maxTokens;
    if (Number(spend.charged) + Number(spend.reserved) + cost > DAILY_CAP_MICRODOLLARS)
      throw new GameError(
        "Today’s shared inference budget is used up. Come back tomorrow (UTC).",
        429,
      );
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
// Charges one Typesafe monitor call: a pre-settled inference row plus the day's and the run's spend,
// in one transaction. It never reserves, so reconcile/expire (which need settled_at IS NULL) skip it.
export async function chargeMonitor(gameId: string, lease: string | null, inputTokens: number) {
  if (!Number.isFinite(inputTokens) || inputTokens < 0) throw new Error("Invalid monitor usage.");
  // ponytail: calls under ~12k input tokens round to 0 microdollars, so the monitor is effectively
  // free. A game-y flat per-call rate is a one-line change here.
  const cost = Math.round(inputTokens * MONITOR_TOKEN_MICRODOLLARS);
  const tokens = Math.ceil(inputTokens);
  await transaction(async (client) => {
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
    if (Number(spend.charged) + Number(spend.reserved) >= DAILY_CAP_MICRODOLLARS)
      throw new GameError(
        "Today’s shared inference budget is used up. Come back tomorrow (UTC).",
        429,
      );
    await client.query(
      `INSERT INTO ctf.inference(id,game_id,day,role,model,token_ceiling,cost_ceiling,tokens,cost,generation_id,settled_at)
      VALUES($1,$2,$3,'monitor','typesafe',$4,$5,$4,$5,NULL,now())`,
      [randomUUID(), gameId, day, tokens, cost],
    );
    await client.query("UPDATE ctf.daily_spend SET charged=charged+$2 WHERE day=$1", [day, cost]);
    await client.query(
      "UPDATE ctf.games SET spent_microdollars=spent_microdollars+$2 WHERE id=$1",
      [gameId, cost],
    );
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
// A hold with no generation id (the request died before the provider answered) can never be
// reconciled. After a day, settle it at its ceiling: never undercount spend, never hold forever.
export async function expireUnverifiableHolds() {
  await transaction(async (client) => {
    const { rows } = await client.query(
      "UPDATE ctf.inference SET tokens=token_ceiling,cost=cost_ceiling,estimated=true,settled_at=now() WHERE settled_at IS NULL AND generation_id IS NULL AND created_at<now()-interval '24 hours' RETURNING game_id,day,token_ceiling,cost_ceiling",
    );
    for (const call of rows) {
      await client.query(
        "UPDATE ctf.daily_spend SET reserved=reserved-$2,charged=charged+$2 WHERE day=$1",
        [call.day, call.cost_ceiling],
      );
      await client.query(
        "UPDATE ctf.games SET tokens_reserved=tokens_reserved-$2,tokens_used=tokens_used+$2,reserved_microdollars=reserved_microdollars-$3,spent_microdollars=spent_microdollars+$3 WHERE id=$1",
        [call.game_id, call.token_ceiling, call.cost_ceiling],
      );
    }
  });
}
// Finalize a terminal (caught/blocked) run's outstanding holds at their ceiling, so forking it isn't
// blocked waiting for a hold that only the 24h sweep would clear — a dead agent call that disconnected
// mid-stream leaves exactly such a hold (no generation id, so reconciliation can never resolve it).
// The run is over, so nothing races this; conservative ceiling settlement never undercounts spend.
export async function finalizeHolds(gameId: string) {
  await transaction(async (client) => {
    const { rows } = await client.query(
      "UPDATE ctf.inference SET tokens=token_ceiling,cost=cost_ceiling,estimated=true,settled_at=now() WHERE game_id=$1 AND settled_at IS NULL RETURNING day,token_ceiling,cost_ceiling",
      [gameId],
    );
    for (const call of rows) {
      await client.query(
        "UPDATE ctf.daily_spend SET reserved=reserved-$2,charged=charged+$2 WHERE day=$1",
        [call.day, call.cost_ceiling],
      );
      await client.query(
        "UPDATE ctf.games SET tokens_reserved=tokens_reserved-$2,tokens_used=tokens_used+$2,reserved_microdollars=reserved_microdollars-$3,spent_microdollars=spent_microdollars+$3 WHERE id=$1",
        [gameId, call.token_ceiling, call.cost_ceiling],
      );
    }
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
