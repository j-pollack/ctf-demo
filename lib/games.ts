import { randomUUID } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";
import type { PoolClient } from "pg";
import { db } from "./db";
import { isAdmin } from "./admin";
import { currentGameRules } from "./game-rules";
import { ASYNC_MONITOR_VERSION } from "./control";
import {
  AGENT_MODEL,
  PLAYER_AGENT_EFFORT,
  MODELS,
  DAILY_CAP_MICRODOLLARS,
  FINAL_REVIEW_ALLOWANCE_MICRODOLLARS,
  MONITOR_RUN_ALLOWANCE_MICRODOLLARS,
  GameError,
  makeSecret,
} from "./policy";
import { TYPESAFE_MODEL } from "./typesafe";
import {
  AGENT_EFFORTS,
  MONITOR_DIFFICULTIES,
  RUN_BUDGET_MICRODOLLARS,
  RUNS_PER_DAY,
  UNVERIFIED_SUBMISSION_STATUS,
  type AgentEffort,
  type GameEvent,
  type GameStatus,
  type MonitorDifficulty,
  type PublicGame,
} from "./types";
import { createEnvironment } from "./sprites";
import { configuredFlagEndpoint, flagEndpointUrl } from "./flag-submission-protocol";
import { persistTranscriptEvidence } from "./transcript-evidence";
import { assertMonitorJobClaim, MAX_REQUEUES, type MonitorJobClaim } from "./monitor-jobs";
import { listSessionSummaries, claimSession } from "./sessions";

export type GameRow = {
  id: string;
  session_id?: string | null;
  execution_generation?: number | string;
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
  monitor_reasoning: boolean;
  monitor_mode: "legacy" | "async";
  submission_transport: "tool" | "http";
  monitor_isolation: boolean;
  bug_fix_required: boolean;
  jailbreak_catch: boolean;
  state_revision: string;
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
// Everything publicGame reads. Excludes `messages`, the full transcript, which polled reads
// would otherwise re-download on every request.
export const PUBLIC_GAME_COLUMNS =
  "id,status,agent_model,agent_effort,system_prompt,token_budget,tokens_used,turns,blocks,budget_microdollars,spent_microdollars,reserved_microdollars,monitor_difficulty,lease_until,monitor_reasoning,monitor_mode,submission_transport,monitor_isolation,bug_fix_required,jailbreak_catch,state_revision,sprite_deleted_at,updated_at";
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
  | "monitor_mode"
  | "submission_transport"
  | "monitor_isolation"
  | "bug_fix_required"
  | "jailbreak_catch"
  | "state_revision"
  | "sprite_deleted_at"
  | "updated_at"
>;
export async function getGame(id: string, ownerId: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    throw new GameError("Run not found.", 404);
  const { rows } = await db.query<GameRow>("SELECT * FROM ctf.games WHERE id=$1 AND owner_id=$2", [
    id,
    ownerId,
  ]);
  if (!rows[0]) throw new GameError("Run not found.", 404);
  const { rows: sessions } = await db.query<GameRow>(
    "SELECT id AS session_id,agent_model,agent_effort,system_prompt,messages,turns,lease,lease_until FROM ctf.agent_sessions WHERE game_id=$1 AND ordinal=1",
    [id],
  );
  return sessions[0] ? { ...rows[0], ...sessions[0] } : rows[0];
}
export async function getPublicGameRow(id: string, ownerId: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    throw new GameError("Run not found.", 404);
  const { rows } = await db.query<PublicGameRow>(
    `SELECT ${PUBLIC_GAME_COLUMNS} FROM ctf.games WHERE id=$1 AND owner_id=$2`,
    [id, ownerId],
  );
  if (!rows[0]) throw new GameError("Run not found.", 404);
  return rows[0];
}
// The player's side of a run is its agent and screen rows, the monitor's side its monitor rows.
// Settled rows count at `cost`, unsettled rows at `cost_ceiling`. Two predicates on settled_at,
// so each sum uses its own partial index.
export type RunSpend = {
  playerSpent: number;
  playerHeld: number;
  monitorSpent: number;
  monitorHeld: number;
  agentSpent: number;
};
export async function runSpend(
  q: { query: (text: string, values: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  gameId: string,
): Promise<RunSpend> {
  const { rows } = await q.query(
    `SELECT s.player_spent,s.monitor_spent,s.agent_spent,h.player_held,h.monitor_held FROM
      (SELECT coalesce(sum(cost) FILTER (WHERE role IN ('agent','screen')),0) AS player_spent,
        coalesce(sum(cost) FILTER (WHERE role='monitor'),0) AS monitor_spent,
        coalesce(sum(cost) FILTER (WHERE role='agent'),0) AS agent_spent
       FROM ctf.inference WHERE game_id=$1 AND settled_at IS NOT NULL) s,
      (SELECT coalesce(sum(cost_ceiling) FILTER (WHERE role IN ('agent','screen')),0) AS player_held,
        coalesce(sum(cost_ceiling) FILTER (WHERE role='monitor'),0) AS monitor_held
       FROM ctf.inference WHERE game_id=$1 AND settled_at IS NULL) h`,
    [gameId],
  );
  const row = rows[0];
  return {
    playerSpent: Number(row.player_spent),
    playerHeld: Number(row.player_held),
    monitorSpent: Number(row.monitor_spent),
    monitorHeld: Number(row.monitor_held),
    agentSpent: Number(row.agent_spent),
  };
}
// A monitor request is admitted in full while the monitor's settled spend is below its allowance.
export function assertMonitorAllowance(monitorSpent: number, status: GameStatus) {
  const allowance =
    MONITOR_RUN_ALLOWANCE_MICRODOLLARS +
    (status === "finalizing" ? FINAL_REVIEW_ALLOWANCE_MICRODOLLARS : 0);
  if (monitorSpent >= allowance)
    throw new GameError("The monitor’s budget for this run is used up.", 402);
}
// One read of a run's money, shared by publicGame and the runner's live `billing` frames.
export async function gameBilling(gameId: string) {
  const { rows } = await db.query("SELECT budget_microdollars FROM ctf.games WHERE id=$1", [
    gameId,
  ]);
  const spend = await runSpend(db, gameId);
  return {
    budgetMicrodollars: Number(rows[0].budget_microdollars),
    spentMicrodollars: spend.playerSpent,
    reservedMicrodollars: spend.playerHeld,
    agentSpendMicrodollars: spend.agentSpent,
    monitorSpendMicrodollars: spend.monitorSpent,
  };
}
// The only reader of ctf.refused_texts. Its caller has checked that the viewer owns the run.
async function refusedTextsFor(gameId: string) {
  const { rows } = await db.query<{
    id: string;
    kind: "instruction" | "system_prompt";
    text: string;
    flagged: boolean;
  }>(
    "SELECT id,kind,text,flagged FROM ctf.refused_texts WHERE game_id=$1 ORDER BY created_at,kind",
    [gameId],
  );
  return rows;
}
// afterEventId > 0 returns only newer events, so pollers re-download nothing they already hold.
// Safe because each run has one writer (its lease) and the runner records events sequentially.
export async function publicGame(
  game: PublicGameRow,
  afterEventId = 0,
  selectedSessionId = game.id,
): Promise<PublicGame> {
  const {
    rows: [monitorState],
  } = await db.query<{
    status: GameStatus;
    monitor_mode: "legacy" | "async";
    state_revision: string;
    pending_sessions: string;
    reviewed_updates: string;
    total_updates: string;
    reviewing: boolean;
    unresolved: boolean;
    has_pending_review: boolean;
    uncertain_command: boolean;
    will_retry: boolean;
    last_reviewed_at: Date | null;
    finalization_error: string | null;
    submission_pending: boolean;
    submitted_flag_correct: boolean | null;
  }>(
    `SELECT g.status,g.monitor_mode,g.state_revision::text,g.finalization_error,g.submitted_flag_correct,
      EXISTS(SELECT 1 FROM ctf.flag_submissions r WHERE r.game_id=g.id AND r.promoted_at IS NULL) AS submission_pending,
      EXISTS(SELECT 1 FROM ctf.sprite_operations o
        LEFT JOIN ctf.agent_sessions s ON s.game_id=o.game_id AND s.id=o.session_id
        WHERE o.game_id=g.id AND o.kind='command' AND
        (o.status='unknown' OR (o.status='running' AND
          (s.lease_until IS NULL OR s.lease_until<=now())))) AS uncertain_command,
      count(DISTINCT j.session_id) FILTER (WHERE j.covered_version<j.requested_version)::text AS pending_sessions,
      coalesce(sum(CASE WHEN j.reviewed_version>=j.start_version
        THEN j.reviewed_version-j.start_version+1 ELSE 0 END),0)::text AS reviewed_updates,
      coalesce(sum(j.requested_version-j.start_version+1),0)::text AS total_updates,
      coalesce(bool_or(j.status='reviewing'),false) AS reviewing,
      coalesce(bool_or(j.status='unresolved'),false) AS unresolved,
      coalesce(bool_or(j.status IN ('queued','reviewing')),false) AS has_pending_review,
      g.status='finalizing' AND coalesce(bool_or(j.status='unresolved' AND j.requeues<$2),false) AS will_retry,
      max(j.last_reviewed_at) AS last_reviewed_at
     FROM ctf.games g LEFT JOIN ctf.monitor_jobs j ON j.game_id=g.id
     WHERE g.id=$1 GROUP BY g.id`,
    [game.id, MAX_REQUEUES],
  );
  if (!monitorState) throw new GameError("Run not found.", 404);
  const monitor =
    monitorState.monitor_mode === "async"
      ? {
          status:
            monitorState.status === "caught"
              ? ("caught" as const)
              : monitorState.unresolved ||
                  monitorState.finalization_error ||
                  monitorState.uncertain_command
                ? ("unresolved" as const)
                : monitorState.reviewing
                  ? ("reviewing" as const)
                  : Number(monitorState.pending_sessions) > 0
                    ? ("queued" as const)
                    : ("caught-up" as const),
          pendingSessions: Number(monitorState.pending_sessions),
          reviewedUpdates: Number(monitorState.reviewed_updates),
          totalUpdates: Number(monitorState.total_updates),
          lastReviewedAt: monitorState.last_reviewed_at?.toISOString() ?? null,
          hasPendingReview: monitorState.has_pending_review,
          willRetry: monitorState.will_retry,
          ...((monitorState.unresolved ||
            monitorState.finalization_error ||
            monitorState.uncertain_command) &&
            monitorState.status !== "caught" && {
              reason: monitorState.finalization_error
                ? "Scoring could not be completed. The result remains unconfirmed."
                : "Review could not be completed. The result remains unconfirmed.",
            }),
        }
      : undefined;
  const sessions = await listSessionSummaries(game.id);
  const runTurns = Number(
    (await db.query<{ turns: number }>("SELECT turns FROM ctf.games WHERE id=$1", [game.id]))
      .rows[0]?.turns ?? game.turns,
  );
  const caught = (
    await db.query<{
      session_id: string;
      ordinal: number;
      reason: string | null;
      cause: string | null;
    }>(
      `SELECT e.session_id,s.ordinal,e.data->>'text' AS reason,e.data->>'cause' AS cause FROM ctf.events e
    LEFT JOIN ctf.agent_sessions s ON s.game_id=e.game_id AND s.id=e.session_id
    WHERE e.game_id=$1 AND e.data->>'kind'='monitor' AND e.data->>'decision'='block'
    ORDER BY e.id DESC LIMIT 1`,
      [game.id],
    )
  ).rows[0];
  const unverified =
    monitorState.status === UNVERIFIED_SUBMISSION_STATUS
      ? (
          await db.query<{ cause: string | null }>(
            `SELECT data->>'cause' AS cause FROM ctf.events
             WHERE game_id=$1 AND data->>'kind'='monitor' AND data->>'decision'='unverified'
             ORDER BY id DESC LIMIT 1`,
            [game.id],
          )
        ).rows[0]
      : undefined;
  const selected = sessions.find((session) => session.id === selectedSessionId);
  if (!selected) throw new GameError("Session not found.", 404);
  const { rows } = await db.query<{ id: string; data: Omit<GameEvent, "id"> }>(
    "SELECT id,data FROM ctf.events WHERE game_id=$1 AND session_id=$2 AND id>$3 ORDER BY id",
    [game.id, selectedSessionId, afterEventId],
  );
  const billing = await gameBilling(game.id);
  const summaries = sessions;
  const busy = summaries.some((session) => session.busy);
  const sessionBusy = summaries.find((session) => session.id === selectedSessionId)?.busy ?? false;
  return {
    id: game.id,
    status: monitorState.status,
    monitorMode: monitorState.monitor_mode,
    submissionTransport: game.submission_transport,
    submissionPending: monitorState.submission_pending,
    ...((monitorState.status === "captured" || monitorState.status === "ended") &&
      monitorState.submitted_flag_correct !== null && {
        submissionCorrect: monitorState.submitted_flag_correct,
      }),
    ...(game.submission_transport === "http" && {
      submissionUrl: flagEndpointUrl() ?? undefined,
    }),
    stateRevision: monitorState.state_revision,
    ...(monitor && { monitor }),
    ...(unverified && {
      endReason:
        unverified.cause === "scoring"
          ? ("unverified-scoring" as const)
          : ("unverified-review" as const),
    }),
    agentModel: selected.agentModel,
    agentEffort: selected.agentEffort,
    monitorDifficulty: game.monitor_difficulty,
    rules: {
      monitorIsolation: game.monitor_isolation,
      bugFixRequired: game.bug_fix_required,
      jailbreakCatch: game.jailbreak_catch,
    },
    systemPrompt: selected.systemPrompt,
    tokenBudget: game.token_budget,
    tokensUsed: game.tokens_used,
    turns: runTurns,
    blocks: game.blocks,
    monitorReasoning: game.monitor_reasoning,
    ...billing,
    busy,
    sessionId: selected.id,
    sessionBusy,
    sessions: summaries,
    caughtSessionId: caught?.session_id ?? null,
    caughtSessionOrdinal: caught ? Number(caught.ordinal) : null,
    caughtReason: caught?.reason ?? null,
    caughtCause:
      monitorState.status !== "caught"
        ? null
        : caught?.cause === "jailbreak"
          ? ("jailbreak" as const)
          : ("flag_read" as const),
    refusedTexts: await refusedTextsFor(game.id),
    events: rows.map((row) => ({ ...row.data, id: Number(row.id) })),
  };
}
export async function assertLease(game: GameRow) {
  const result = await db.query(
    `SELECT 1 FROM ctf.games g JOIN ctf.agent_sessions s ON s.game_id=g.id AND s.id=$3
    WHERE g.id=$1 AND s.lease=$2 AND s.lease_until>now() AND g.status='active' AND g.execution_generation=$4`,
    [game.id, game.lease, game.session_id ?? game.id, Number(game.execution_generation ?? 0)],
  );
  if (!result.rowCount) throw new GameError("This response has stopped.", 409);
}
export async function finishSessionRun(game: GameRow, status: GameStatus, blocksDelta = 0) {
  return transaction(async (client) => {
    await client.query("SELECT id FROM ctf.games WHERE id=$1 FOR UPDATE", [game.id]);
    const { rows } = await client.query(
      `UPDATE ctf.games g SET status=$3,blocks=blocks+$4,
        state_revision=state_revision+CASE WHEN g.monitor_mode='async' THEN 1 ELSE 0 END,
        updated_at=now()
      WHERE g.id=$1 AND g.status='active' AND g.execution_generation=$6 AND EXISTS(
        SELECT 1 FROM ctf.agent_sessions s WHERE s.game_id=g.id AND s.id=$5 AND s.lease=$2 AND s.lease_until>now())
      RETURNING g.*`,
      [
        game.id,
        game.lease,
        status,
        blocksDelta,
        game.session_id ?? game.id,
        Number(game.execution_generation ?? 0),
      ],
    );
    if (!rows[0]) throw new GameError("This response has stopped.", 409);
    return rows[0] as GameRow;
  });
}
export async function record(
  gameId: string,
  event: Omit<GameEvent, "id">,
  lease?: string | null,
  sessionId?: string,
  executionGeneration?: number,
) {
  return transaction(async (client) => {
    const { rows: games } = await client.query<{ execution_generation: number | string }>(
      "SELECT execution_generation FROM ctf.games WHERE id=$1 FOR UPDATE",
      [gameId],
    );
    if (!games[0]) throw new GameError("This response has stopped.", 409);
    if (lease) {
      if (
        executionGeneration !== undefined &&
        Number(games[0].execution_generation) !== executionGeneration
      )
        throw new GameError("This response has stopped.", 409);
      const valid = await client.query(
        "SELECT 1 FROM ctf.agent_sessions WHERE game_id=$1 AND id=$2 AND lease=$3 AND lease_until>now()",
        [gameId, sessionId ?? gameId, lease],
      );
      if (!valid.rowCount) throw new GameError("This response has stopped.", 409);
    }
    const { rows } = await client.query(
      "INSERT INTO ctf.events(game_id,data,session_id) VALUES($1,$2,$3) RETURNING id",
      [gameId, JSON.stringify(event), sessionId ?? gameId],
    );
    return { ...event, id: Number(rows[0].id) } as GameEvent;
  });
}
export async function cleanup() {
  await reconcileInference();
  await expireUnverifiableHolds();
  await db.query(
    "UPDATE ctf.games SET status='ended',state_revision=state_revision+CASE WHEN monitor_mode='async' THEN 1 ELSE 0 END WHERE status='creating' AND updated_at<now()-interval '5 minutes'",
  );
  await db.query(
    "UPDATE ctf.games SET status='ended',lease=NULL,lease_until=NULL,state_revision=state_revision+CASE WHEN monitor_mode='async' THEN 1 ELSE 0 END WHERE (status IN ('active','creating') OR (status='finalizing' AND monitor_mode='legacy')) AND updated_at < now()-interval '24 hours'",
  );
  await db.query(
    `UPDATE ctf.agent_sessions s SET lease=NULL,lease_until=NULL WHERE s.lease_until<now()
      AND NOT EXISTS(SELECT 1 FROM ctf.games g WHERE g.id=s.game_id AND g.status='finalizing')`,
  );
  // A sprite is destroyed once, when every run on it is done.
  const { rows } = await db.query<{ sprite_name: string }>(
    `SELECT g.sprite_name FROM ctf.games g
    WHERE g.sprite_name IN (SELECT sprite_name FROM ctf.games WHERE sprite_deleted_at IS NULL)
    GROUP BY g.sprite_name
    HAVING bool_or(g.sprite_deleted_at IS NULL)
      AND bool_and(g.status IN ('captured','exhausted','ended','blocked','caught')) LIMIT 20`,
  );
  await Promise.all(
    rows.map(async ({ sprite_name }) => {
      try {
        const { deleteSpriteIfEligible } = await import("./monitor-commands");
        await deleteSpriteIfEligible(sprite_name);
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
// New runs the owner can still start in the rolling day that admission counts; null for an admin,
// who has no limit. Admission in startGame stays the authority, so this is for display only.
export async function newRunsLeft(ownerId: string): Promise<number | null> {
  const { rows } = await db.query<{
    total: number;
    isAdmin: boolean | null;
    isAnonymous: boolean | null;
  }>(
    `SELECT (SELECT count(*)::int FROM ctf.games WHERE owner_id=$1 AND new_run AND created_at > now()-interval '24 hours') AS total,
       (SELECT "isAdmin" FROM ctf."user" WHERE id=$1) AS "isAdmin",
       (SELECT "isAnonymous" FROM ctf."user" WHERE id=$1) AS "isAnonymous"`,
    [ownerId],
  );
  if (isAdmin(rows[0])) return null;
  return Math.max(0, RUNS_PER_DAY - rows[0].total);
}
const STOP_WAIT_MS = 20_000;
const STOP_POLL_MS = 250;
// A new run replaces the owner's open one, so its responses in progress are asked to stop and
// given time to settle. Admission still refuses a response that outlasts the wait, or a legacy
// one, which cannot be asked.
async function stopOwnedResponses(ownerId: string) {
  for (const deadline = Date.now() + STOP_WAIT_MS; Date.now() < deadline;) {
    const { rowCount } = await db.query(
      `UPDATE ctf.agent_sessions s SET stop_requested_at=now() FROM ctf.games g
      WHERE g.id=s.game_id AND g.owner_id=$1 AND g.status='active' AND g.monitor_mode='async'
        AND NOT EXISTS(SELECT 1 FROM ctf.flag_submissions r WHERE r.game_id=g.id)
        AND s.lease_until>now()`,
      [ownerId],
    );
    if (!rowCount) return;
    await new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS));
  }
}
export async function startGame(
  ownerId: string,
  agentModel?: string,
  options: MonitorOptions & { agentEffort?: unknown } = {},
) {
  if (agentModel !== undefined && !MODELS.includes(agentModel))
    throw new GameError("Unsupported agent model.");
  const effort = checkEffort(options.agentEffort);
  // Before cleanup and admission: a bad choice must neither create a run nor end the current one.
  const monitor = checkMonitor(options);
  let submissionUrl: string;
  try {
    submissionUrl = configuredFlagEndpoint().url;
  } catch {
    throw new GameError(
      "HTTP submission is not configured yet. A run cannot start until the submission endpoint is available.",
      503,
    );
  }
  await stopOwnedResponses(ownerId);
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
      throw new GameError(
        "Today’s shared inference budget is used up. Come back tomorrow (UTC).",
        429,
      );
    const existing = await client.query<GameRow>(
      "SELECT * FROM ctf.games WHERE owner_id=$1 AND status IN ('creating','active','finalizing') FOR UPDATE",
      [ownerId],
    );
    if (
      existing.rows.some(
        (row) =>
          row.status === "creating" ||
          (row.status === "finalizing" && row.monitor_mode === "legacy"),
      )
    )
      throw new GameError("Wait for your current run to finish starting or responding.", 409);
    const busyOwned = await client.query(
      `SELECT 1 FROM ctf.agent_sessions s JOIN ctf.games g ON g.id=s.game_id
      WHERE g.owner_id=$1 AND (g.status IN ('creating','active') OR
        (g.status='finalizing' AND g.monitor_mode='legacy'))
        AND s.lease_until>now() LIMIT 1`,
      [ownerId],
    );
    if (busyOwned.rowCount)
      throw new GameError("Wait for your current run to finish starting or responding.", 409);
    const count = await client.query(
      `SELECT count(DISTINCT sprite_name)::int AS total FROM ctf.games
       WHERE status IN ('creating','active','finalizing')
         AND (owner_id<>$1 OR (status='finalizing' AND monitor_mode='async'))`,
      [ownerId],
    );
    if (count.rows[0].total >= 10)
      throw new GameError("All environments are busy. Try again in a few minutes.", 429);
    const starts = await client.query(
      "SELECT count(*)::int AS total FROM ctf.games WHERE owner_id=$1 AND new_run AND created_at > now()-interval '24 hours'",
      [ownerId],
    );
    if (starts.rows[0].total >= RUNS_PER_DAY) {
      // Read current privileges inside admission; request/session hints cannot grant an exemption.
      const owner = await client.query<{ isAdmin: boolean | null; isAnonymous: boolean | null }>(
        'SELECT "isAdmin","isAnonymous" FROM ctf."user" WHERE id=$1',
        [ownerId],
      );
      if (!isAdmin(owner.rows[0]))
        throw new GameError("You’ve reached your daily limit of new runs.", 429);
    }
    const totalStarts = await client.query(
      "SELECT count(*)::int AS total FROM ctf.games WHERE new_run AND created_at>now()-interval '24 hours'",
    );
    if (totalStarts.rows[0].total >= 100)
      throw new GameError("No more new runs can start today. Come back tomorrow (UTC).", 429);
    await client.query(
      "UPDATE ctf.games SET status='ended',lease=NULL,lease_until=NULL,state_revision=state_revision+CASE WHEN monitor_mode='async' THEN 1 ELSE 0 END WHERE owner_id=$1 AND status IN ('creating','active')",
      [ownerId],
    );
    const rules = await currentGameRules(client);
    const { rows } = await client.query<GameRow>(
      `INSERT INTO ctf.games(id,owner_id,sprite_name,secret_hash,agent_model,monitor_model,monitor_difficulty,monitor_version,token_budget,budget_microdollars,system_prompt,monitor_reasoning,status,agent_effort,new_run,monitor_mode,submission_transport,monitor_isolation,bug_fix_required,jailbreak_catch)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true,'async','http',$15,$16,$17) RETURNING *`,
      [
        id,
        ownerId,
        `ctf-${id}`,
        hash,
        agentModel ?? AGENT_MODEL,
        TYPESAFE_MODEL,
        monitor.difficulty ?? "hard",
        ASYNC_MONITOR_VERSION,
        500000,
        RUN_BUDGET_MICRODOLLARS,
        "",
        true,
        "creating",
        effort ?? PLAYER_AGENT_EFFORT,
        rules.monitorIsolation,
        rules.bugFixRequired,
        rules.jailbreakCatch,
      ],
    );
    await client.query(
      `INSERT INTO ctf.agent_sessions(id,game_id,ordinal,agent_model,agent_effort,system_prompt)
       VALUES($1,$1,1,$2,$3,'')`,
      [id, agentModel ?? AGENT_MODEL, effort ?? PLAYER_AGENT_EFFORT],
    );
    await persistTranscriptEvidence(client, {
      gameId: id,
      sessionId: id,
      runRevision: 0,
      messages: [],
    });
    return rows[0];
  });
  try {
    await createEnvironment(game.sprite_name, secret, submissionUrl);
    await db.query(
      "UPDATE ctf.games SET status='active',state_revision=state_revision+1,updated_at=now() WHERE id=$1",
      [id],
    );
    game.status = "active";
    await cleanup();
    return publicGame(game);
  } catch (error) {
    await db.query(
      "UPDATE ctf.games SET status='ended',state_revision=state_revision+1 WHERE id=$1",
      [id],
    );
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
  return claimGameSession(id, id, ownerId, agentModel, systemPrompt, monitorOptions, agentEffort);
}
export async function claimGameSession(
  id: string,
  sessionId: string,
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
  const claimed = await claimSession(id, sessionId, ownerId, {
    agentModel,
    agentEffort: effort,
    systemPrompt: systemPrompt === undefined ? undefined : systemPrompt.trim() ? systemPrompt : "",
    monitorDifficulty: monitor.difficulty,
    monitorReasoning: monitor.reasoning,
  });
  return {
    ...claimed.game,
    id,
    session_id: sessionId,
    agent_model: claimed.session.agent_model,
    agent_effort: claimed.session.agent_effort,
    system_prompt: claimed.session.system_prompt,
    messages: claimed.session.messages,
    turns: claimed.session.turns,
    lease: claimed.lease,
    lease_until: claimed.session.lease_until,
  } as GameRow;
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
export type InferenceRole = "agent" | "monitor" | "screen";
export async function reserveInference(
  gameId: string,
  lease: string | null,
  role: InferenceRole,
  model: string,
  input: number,
  wantedOutput: number,
  inputRate: number,
  outputRate = inputRate,
  context: {
    sessionId?: string;
    reviewId?: string;
    executionGeneration?: number;
    jobClaim?: MonitorJobClaim;
  } = {},
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
    const sessionId = context.sessionId ?? game?.id;
    // A screen is authorized like an agent call, by the session lease and generation, never a claim.
    const leaseHeld = role === "agent" || role === "screen";
    if (role === "screen" && (context.jobClaim || context.executionGeneration === undefined))
      throw new GameError("This response has stopped.", 409);
    const session =
      game &&
      (
        await client.query<{ lease: string; lease_until: Date }>(
          "SELECT lease,lease_until FROM ctf.agent_sessions WHERE game_id=$1 AND id=$2 FOR UPDATE",
          [gameId, sessionId],
        )
      ).rows[0];
    if (
      !game ||
      (leaseHeld && game.status !== "active") ||
      (leaseHeld &&
        game.submission_transport === "http" &&
        !!(await client.query("SELECT 1 FROM ctf.flag_submissions WHERE game_id=$1", [gameId]))
          .rowCount) ||
      (!context.jobClaim &&
        context.executionGeneration !== undefined &&
        Number(game.execution_generation) !== context.executionGeneration) ||
      !session ||
      (!context.jobClaim &&
        (session.lease !== lease || new Date(session.lease_until).getTime() <= Date.now()))
    )
      throw new GameError("This response has stopped.", 409);
    if (role === "monitor") {
      if (!context.jobClaim) throw new GameError("Monitor review authorization is required.", 409);
      await assertMonitorJobClaim(client, context.jobClaim);
    }
    const run = await runSpend(client, gameId);
    const available = Number(game.budget_microdollars) - run.playerSpent - run.playerHeld;
    if (role === "monitor") assertMonitorAllowance(run.monitorSpent, game.status);
    const allowance =
      role === "monitor"
        ? { maxTokens: wantedOutput }
        : requestAllowance(input, wantedOutput, inputRate, outputRate, available);
    if (allowance.maxTokens < 64) {
      // An agent past its budget is exhausted unless a sibling's paid agent call is still unsettled.
      const spentOut =
        role === "agent" &&
        run.playerSpent >= Number(game.budget_microdollars) &&
        !(
          await client.query(
            "SELECT 1 FROM ctf.inference WHERE game_id=$1 AND role='agent' AND settled_at IS NULL LIMIT 1",
            [gameId],
          )
        ).rowCount;
      throw new GameError(
        spentOut
          ? "Your inference budget is exhausted."
          : run.playerHeld > 0
            ? "There isn’t enough available budget for this request. Some billing is still pending."
            : available <= 0
              ? "Your inference budget is exhausted."
              : "There isn’t enough budget for this request. Start a new run.",
        spentOut || (available <= 0 && run.playerHeld === 0) ? 402 : 400,
      );
    }
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
      "INSERT INTO ctf.inference(id,game_id,day,role,model,token_ceiling,cost_ceiling,session_id,review_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [id, gameId, day, role, model, tokens, cost, sessionId, context.reviewId ?? null],
    );
    return { id, maxTokens, tokens, cost };
  });
}
export async function settleInference(
  id: string,
  usage?: { tokens: number; generationId?: string } & (
    | { cost: number; costMicrodollars?: never }
    | { costMicrodollars: number; cost?: never }
  ),
) {
  // Unknown billing remains a pending hold, never a fabricated charge.
  if (!usage) return;
  const cost = usage.costMicrodollars ?? Math.ceil(usage.cost! * 1_000_000);
  if (
    !Number.isFinite(usage.tokens) ||
    usage.tokens < 0 ||
    !Number.isSafeInteger(cost) ||
    cost < 0 ||
    (usage.cost !== undefined && (!Number.isFinite(usage.cost) || usage.cost < 0))
  )
    throw new Error("Invalid inference usage.");
  await transaction(async (client) => {
    const call = (await client.query("SELECT * FROM ctf.inference WHERE id=$1 FOR UPDATE", [id]))
      .rows[0];
    if (!call || call.settled_at) return;
    const tokens = Math.ceil(usage.tokens);
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
// A hold the provider's record never settles (no generation id, or a record that never becomes
// usable) is released after a day at its ceiling: never undercount spend, never hold forever.
export async function expireUnverifiableHolds() {
  await transaction(async (client) => {
    const { rows } = await client.query(
      "UPDATE ctf.inference SET tokens=token_ceiling,cost=cost_ceiling,estimated=true,settled_at=now() WHERE settled_at IS NULL AND created_at<now()-interval '24 hours' RETURNING game_id,day,token_ceiling,cost_ceiling",
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
