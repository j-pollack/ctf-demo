import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { db } from "./db";
import { GameError } from "./policy";

export type FinalStatus = "captured" | "exhausted" | "ended";
export const FINALIZATION_LEASE_MS = 60_000;
export type Finalization = {
  token: string;
  revision: number;
  executionGeneration: number;
  pendingReviewIds: string[];
  sessionId: string;
  sourceLease: string;
  deadline: Date;
};
export type ReviewAuthorization = {
  reviewId?: string;
  finalizationToken?: string;
  pendingReviewId?: string;
};
export type ReviewDecision = {
  verdict: "allow" | "block" | "unknown";
  reason?: string;
  evidence?: unknown;
  operationalError?: string;
  latencyMs?: number;
  calls?: number;
  retrievalCalls?: number;
  initialEvidenceCount?: number;
  retrievedRefs?: string[];
};

async function withTransaction<T>(run: (client: PoolClient) => Promise<T>) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const value = await run(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function lockRunAndSession(client: PoolClient, gameId: string, sessionId: string) {
  const {
    rows: [run],
  } = await client.query<{
    status: string;
    observation_revision: string;
    execution_generation: string;
    finalization_token: string | null;
    finalization_lease_until: Date | null;
  }>(
    "SELECT status,observation_revision,execution_generation,finalization_token,finalization_lease_until FROM ctf.games WHERE id=$1 FOR UPDATE",
    [gameId],
  );
  if (!run) throw new GameError("Run not found.", 404);
  const {
    rows: [session],
  } = await client.query<{ lease: string | null; lease_until: Date | null }>(
    "SELECT lease,lease_until FROM ctf.agent_sessions WHERE game_id=$1 AND id=$2 FOR UPDATE",
    [gameId, sessionId],
  );
  if (!session) throw new GameError("Session not found.", 404);
  return { run, session };
}

/** Register before remote monitor work so a submit barrier can capture the exact drain set. */
export async function insertLifecycleReview(
  client: PoolClient,
  input: {
    id: string;
    gameId: string;
    sessionId: string;
    sourceLease: string;
    snapshotRevision: number;
    targetKind: "transcript";
    model: string;
    promptVersion: string;
    executionGeneration: number;
    eligibleDrainToken?: string;
  },
) {
  if (!Number.isSafeInteger(input.snapshotRevision) || input.snapshotRevision < 0)
    throw new GameError("Invalid monitor snapshot revision.", 400);
  const { run, session } = await lockRunAndSession(client, input.gameId, input.sessionId);
  const finalizingPending =
    run.status === "finalizing" &&
    input.eligibleDrainToken === run.finalization_token &&
    !!run.finalization_lease_until &&
    run.finalization_lease_until > new Date();
  if (
    (run.status !== "active" && !finalizingPending) ||
    Number(run.execution_generation) !== input.executionGeneration ||
    session.lease !== input.sourceLease ||
    !session.lease_until ||
    session.lease_until <= new Date()
  )
    throw new GameError("This response has stopped.", 409);
  if (Number(run.observation_revision) < input.snapshotRevision)
    throw new GameError("The monitor snapshot is no longer available.", 409);
  const { rowCount } = await client.query(
    `INSERT INTO ctf.monitor_reviews(id,game_id,session_id,snapshot_revision,target_kind,model,prompt_version,
      originating_lease,eligible_drain_token,execution_generation)
     VALUES($1,$2,$3,$4,'transcript',$5,$6,$7,$8,$9)`,
    [
      input.id,
      input.gameId,
      input.sessionId,
      input.snapshotRevision,
      input.model,
      input.promptVersion,
      input.sourceLease,
      input.eligibleDrainToken ?? null,
      input.executionGeneration,
    ],
  );
  if (!rowCount) throw new GameError("Could not queue monitor review.", 409);
  return input.id;
}

/** Bind a queued transcript trigger to the immutable snapshot captured after persistence. */
export async function bindQueuedLifecycleReview(
  reviewId: string,
  gameId: string,
  sessionId: string,
  sourceLease: string,
  executionGeneration: number,
  snapshotRevision: number,
) {
  if (!Number.isSafeInteger(snapshotRevision) || snapshotRevision < 0)
    throw new GameError("Invalid monitor snapshot revision.", 400);
  return withTransaction(async (client) => {
    const { run, session } = await lockRunAndSession(client, gameId, sessionId);
    const {
      rows: [review],
    } = await client.query<{
      snapshot_revision: string;
      eligible_drain_token: string | null;
      target_kind: string;
      completed_at: Date | null;
      originating_lease: string | null;
      execution_generation: string;
    }>(
      `SELECT snapshot_revision,eligible_drain_token,target_kind,completed_at,originating_lease,execution_generation
       FROM ctf.monitor_reviews WHERE id=$1 AND game_id=$2 AND session_id=$3 FOR UPDATE`,
      [reviewId, gameId, sessionId],
    );
    const finalizingPending =
      run.status === "finalizing" &&
      !!run.finalization_token &&
      review?.eligible_drain_token === run.finalization_token &&
      !!run.finalization_lease_until &&
      run.finalization_lease_until > new Date();
    if (
      (run.status !== "active" && !finalizingPending) ||
      Number(run.execution_generation) !== executionGeneration ||
      session.lease !== sourceLease ||
      !session.lease_until ||
      session.lease_until <= new Date() ||
      !review ||
      review.target_kind !== "transcript" ||
      review.completed_at !== null ||
      review.originating_lease !== sourceLease ||
      Number(review.execution_generation) !== executionGeneration ||
      snapshotRevision < Number(review.snapshot_revision) ||
      snapshotRevision > Number(run.observation_revision)
    )
      throw new GameError("The queued monitor review is no longer valid.", 409);
    await client.query(
      "UPDATE ctf.monitor_reviews SET snapshot_revision=$2 WHERE id=$1 AND completed_at IS NULL",
      [reviewId, snapshotRevision],
    );
    return reviewId;
  });
}

export async function registerLifecycleReview(input: {
  id: string;
  gameId: string;
  sessionId: string;
  sourceLease: string;
  finalizationToken?: string;
  snapshotRevision: number;
  targetKind: "transcript" | "command" | "submission";
  toolCallId?: string;
  command?: string;
  classifierSignals?: unknown;
  model: string;
  promptVersion: string;
}) {
  if (!Number.isSafeInteger(input.snapshotRevision) || input.snapshotRevision < 0)
    throw new GameError("Invalid monitor snapshot revision.", 400);
  return withTransaction(async (client) => {
    const { run, session } = await lockRunAndSession(client, input.gameId, input.sessionId);
    const finalizer =
      run.status === "finalizing" &&
      input.finalizationToken === run.finalization_token &&
      !!run.finalization_lease_until &&
      run.finalization_lease_until > new Date();
    if (
      (run.status !== "active" && !finalizer) ||
      session.lease !== input.sourceLease ||
      !session.lease_until ||
      session.lease_until <= new Date()
    )
      throw new GameError("This response has stopped.", 409);
    if (Number(run.observation_revision) < input.snapshotRevision)
      throw new GameError("The monitor snapshot is no longer available.", 409);
    const { rowCount } = await client.query(
      `INSERT INTO ctf.monitor_reviews(id,game_id,session_id,snapshot_revision,target_kind,tool_call_id,command,
        classifier_signals,model,prompt_version,originating_lease,execution_generation,finalization_token)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        input.id,
        input.gameId,
        input.sessionId,
        input.snapshotRevision,
        input.targetKind,
        input.toolCallId ?? null,
        input.command ?? null,
        JSON.stringify(input.classifierSignals ?? {}),
        input.model,
        input.promptVersion,
        input.sourceLease,
        run.execution_generation,
        input.finalizationToken ?? null,
      ],
    );
    if (!rowCount) throw new GameError("Could not register monitor review.", 409);
    return input.id;
  });
}

/** Close attacker work and atomically tag the only reviews allowed to drain. */
export async function beginFinalization(
  gameId: string,
  sessionId: string,
  sourceLease: string,
): Promise<Finalization> {
  return withTransaction(async (client) => {
    const { run, session } = await lockRunAndSession(client, gameId, sessionId);
    if (
      run.status !== "active" ||
      session.lease !== sourceLease ||
      !session.lease_until ||
      session.lease_until <= new Date()
    )
      throw new GameError("This response has stopped.", 409);
    const token = randomUUID();
    const {
      rows: [updated],
    } = await client.query<{ execution_generation: string; finalization_lease_until: Date }>(
      `UPDATE ctf.games SET status='finalizing',finalization_token=$2,
        finalization_lease_until=LEAST(now()+($3::int * interval '1 millisecond'),$4::timestamptz),
        monitor_settings_locked=true,updated_at=now()
       WHERE id=$1 AND status='active' RETURNING execution_generation,finalization_lease_until`,
      [gameId, token, FINALIZATION_LEASE_MS, session.lease_until],
    );
    if (!updated) throw new GameError("This run is already finalizing.", 409);
    const { rows } = await client.query<{ id: string }>(
      `UPDATE ctf.monitor_reviews SET eligible_drain_token=$2
       WHERE game_id=$1 AND completed_at IS NULL RETURNING id`,
      [gameId, token],
    );
    return {
      token,
      revision: Number(run.observation_revision),
      executionGeneration: Number(updated.execution_generation),
      pendingReviewIds: rows.map((row) => row.id),
      sessionId,
      sourceLease,
      deadline: updated.finalization_lease_until,
    };
  });
}

/** Use inside reservation/settlement transactions after the daily row is locked. */
export async function assertMonitorAuthorization(
  client: PoolClient,
  gameId: string,
  sessionId: string,
  sourceLease: string,
  authorization: ReviewAuthorization,
) {
  const {
    rows: [run],
  } = await client.query<{
    status: string;
    finalization_token: string | null;
    finalization_lease_until: Date | null;
  }>("SELECT status,finalization_token,finalization_lease_until FROM ctf.games WHERE id=$1", [
    gameId,
  ]);
  const {
    rows: [session],
  } = await client.query<{ lease: string | null; lease_until: Date | null }>(
    "SELECT lease,lease_until FROM ctf.agent_sessions WHERE game_id=$1 AND id=$2",
    [gameId, sessionId],
  );
  const liveLease =
    session?.lease === sourceLease && !!session.lease_until && session.lease_until > new Date();
  if (!run || !liveLease) throw new GameError("This response has stopped.", 409);
  if (run.status === "active") {
    if (!authorization.reviewId) throw new GameError("Monitor authorization is required.", 409);
    const { rowCount } = await client.query(
      `SELECT 1 FROM ctf.monitor_reviews WHERE id=$1 AND game_id=$2 AND session_id=$3
        AND originating_lease=$4 AND completed_at IS NULL
        AND execution_generation=(SELECT execution_generation FROM ctf.games WHERE id=$2)`,
      [authorization.reviewId, gameId, sessionId, sourceLease],
    );
    if (!rowCount) throw new GameError("Monitor review is no longer active.", 409);
    return;
  }
  if (
    run.status !== "finalizing" ||
    !run.finalization_lease_until ||
    run.finalization_lease_until <= new Date()
  )
    throw new GameError("This response has stopped.", 409);
  if (authorization.finalizationToken && authorization.finalizationToken === run.finalization_token)
    return;
  if (authorization.pendingReviewId) {
    const { rowCount } = await client.query(
      `SELECT 1 FROM ctf.monitor_reviews WHERE id=$1 AND game_id=$2 AND session_id=$3
        AND originating_lease=$4 AND eligible_drain_token=$5 AND completed_at IS NULL
        AND execution_generation=(SELECT execution_generation FROM ctf.games WHERE id=$2)`,
      [authorization.pendingReviewId, gameId, sessionId, sourceLease, run.finalization_token],
    );
    if (rowCount) return;
  }
  throw new GameError("Monitor work is not authorized during finalization.", 409);
}

/** Release a live barrier and revoke every command permit admitted before it. */
export async function releaseFinalization(gameId: string, token: string) {
  return withTransaction(async (client) => {
    await client.query("SELECT id FROM ctf.games WHERE id=$1 FOR UPDATE", [gameId]);
    const { rows } = await client.query(
      `UPDATE ctf.games SET status='active',finalization_token=NULL,finalization_lease_until=NULL,
        execution_generation=execution_generation+1,updated_at=now()
       WHERE id=$1 AND status='finalizing' AND finalization_token=$2 AND finalization_lease_until>now()
       RETURNING observation_revision,execution_generation`,
      [gameId, token],
    );
    return rows[0]
      ? {
          revision: Number(rows[0].observation_revision),
          executionGeneration: Number(rows[0].execution_generation),
        }
      : null;
  });
}

/** Final capture succeeds only after every pre-barrier review and admitted command is resolved. */
export async function getDrainReadiness(gameId: string, token: string, finalizerSessionId: string) {
  const { rows: pending } = await db.query<{ id: string }>(
    `SELECT id FROM ctf.monitor_reviews WHERE game_id=$1 AND eligible_drain_token=$2
     AND (completed_at IS NULL OR verdict IS DISTINCT FROM 'allow' OR operational_error IS NOT NULL) ORDER BY id`,
    [gameId, token],
  );
  const { rows: missing } = await db.query<{ id: string }>(
    `SELECT id FROM ctf.monitor_reviews WHERE game_id=$1 AND admitted_revision IS NOT NULL
     AND completed_revision IS NULL ORDER BY id`,
    [gameId],
  );
  const { rows: busy } = await db.query<{ id: string }>(
    `SELECT id FROM ctf.agent_sessions WHERE game_id=$1 AND id<>$2 AND lease IS NOT NULL ORDER BY ordinal`,
    [gameId, finalizerSessionId],
  );
  return {
    ready: pending.length === 0 && missing.length === 0 && busy.length === 0,
    pendingReviewIds: pending.map((row) => row.id),
    missingCommandReviewIds: missing.map((row) => row.id),
    busySessionIds: busy.map((row) => row.id),
  };
}

export async function finalizeRun(
  gameId: string,
  token: string,
  expectedRevision: number,
  status: FinalStatus,
  finalReviewId: string,
  finalizer: { sessionId: string; sourceLease: string },
) {
  return withTransaction(async (client) => {
    const {
      rows: [run],
    } = await client.query<{ observation_revision: string }>(
      "SELECT observation_revision FROM ctf.games WHERE id=$1 AND status='finalizing' AND finalization_token=$2 AND finalization_lease_until>now() FOR UPDATE",
      [gameId, token],
    );
    if (!run || Number(run.observation_revision) !== expectedRevision) return null;
    const { rowCount: liveFinalizer } = await client.query(
      `SELECT 1 FROM ctf.agent_sessions WHERE game_id=$1 AND id=$2
       AND lease=$3 AND lease_until>now() FOR UPDATE`,
      [gameId, finalizer.sessionId, finalizer.sourceLease],
    );
    if (!liveFinalizer) return null;
    const { rowCount: unresolved } = await client.query(
      `SELECT 1 FROM ctf.monitor_reviews WHERE game_id=$1 AND eligible_drain_token=$2
       AND (completed_at IS NULL OR verdict IS DISTINCT FROM 'allow' OR operational_error IS NOT NULL) LIMIT 1`,
      [gameId, token],
    );
    const { rowCount: missingOutcome } = await client.query(
      `SELECT 1 FROM ctf.monitor_reviews WHERE game_id=$1 AND admitted_revision IS NOT NULL
       AND completed_revision IS NULL LIMIT 1`,
      [gameId],
    );
    const { rowCount: busySibling } = await client.query(
      `SELECT 1 FROM ctf.agent_sessions WHERE game_id=$1 AND id<>$2 AND lease IS NOT NULL LIMIT 1`,
      [gameId, finalizer.sessionId],
    );
    if (unresolved || missingOutcome || busySibling) return null;
    const { rowCount: validFinalReview } = await client.query(
      `SELECT 1 FROM ctf.monitor_reviews WHERE id=$1 AND game_id=$2 AND snapshot_revision=$3
        AND target_kind='submission' AND verdict='allow' AND completed_at IS NOT NULL
        AND operational_error IS NULL AND finalization_token=$4 AND session_id=$5 AND originating_lease=$6`,
      [finalReviewId, gameId, expectedRevision, token, finalizer.sessionId, finalizer.sourceLease],
    );
    if (!validFinalReview) return null;
    const { rows } = await client.query(
      `UPDATE ctf.games SET status=$3,finalization_token=NULL,finalization_lease_until=NULL,
        updated_at=now() WHERE id=$1 AND status='finalizing' AND finalization_token=$2
        AND observation_revision=$4 RETURNING observation_revision`,
      [gameId, token, status, expectedRevision],
    );
    return rows[0] ? { token, revision: Number(rows[0].observation_revision), status } : null;
  });
}

/** Atomically persist a decisive block and its event; it wins against finalization. */
export async function catchRun<Event extends Record<string, unknown>>(input: {
  gameId: string;
  sessionId: string;
  sourceLease: string;
  reviewId: string;
  decision: ReviewDecision;
  event: Event;
}): Promise<false | { status: "caught"; event: Event & { id: number } }> {
  if (input.decision.verdict !== "block")
    throw new GameError("A catch requires a block verdict.", 400);
  return withTransaction(async (client) => {
    await client.query("SELECT id FROM ctf.games WHERE id=$1 FOR UPDATE", [input.gameId]);
    const { rowCount: liveSource } = await client.query(
      `SELECT 1 FROM ctf.agent_sessions WHERE game_id=$1 AND id=$2 AND lease=$3 AND lease_until>now() FOR UPDATE`,
      [input.gameId, input.sessionId, input.sourceLease],
    );
    if (!liveSource) return false;
    const { rows: reviews } = await client.query(
      `UPDATE ctf.monitor_reviews SET verdict='block',reason=$4,evidence=$5,operational_error=$6,
        latency_ms=$7,calls=$8,retrieval_calls=$9,initial_evidence_count=$10,retrieved_refs=$11,completed_at=now()
       WHERE id=$1 AND game_id=$2 AND session_id=$3 AND originating_lease=$12 AND completed_at IS NULL
         AND EXISTS(SELECT 1 FROM ctf.games WHERE id=$2 AND status IN ('active','finalizing'))
       RETURNING id`,
      [
        input.reviewId,
        input.gameId,
        input.sessionId,
        input.decision.reason ?? null,
        JSON.stringify(input.decision.evidence ?? []),
        input.decision.operationalError ?? null,
        input.decision.latencyMs ?? null,
        input.decision.calls ?? null,
        input.decision.retrievalCalls ?? null,
        input.decision.initialEvidenceCount ?? null,
        JSON.stringify(input.decision.retrievedRefs ?? []),
        input.sourceLease,
      ],
    );
    if (!reviews[0]) return false;
    const { rows: games } = await client.query(
      `UPDATE ctf.games SET status='caught',blocks=blocks+1,finalization_token=NULL,finalization_lease_until=NULL,
        execution_generation=execution_generation+1,updated_at=now()
       WHERE id=$1 AND status IN ('active','finalizing') RETURNING id`,
      [input.gameId],
    );
    if (!games[0]) return false;
    const {
      rows: [persisted],
    } = await client.query<{ id: string }>(
      "INSERT INTO ctf.events(game_id,session_id,review_id,data) VALUES($1,$2,$3,$4) RETURNING id",
      [input.gameId, input.sessionId, input.reviewId, JSON.stringify(input.event)],
    );
    return { status: "caught" as const, event: { ...input.event, id: Number(persisted.id) } };
  });
}

/** Fences command dispatch against a released barrier and an expired or replaced session lease. */
export async function assertExecutionPermit(
  client: PoolClient,
  input: { gameId: string; sessionId: string; lease: string; reviewId: string; generation: number },
) {
  const { rowCount } = await client.query(
    `SELECT 1 FROM ctf.games g JOIN ctf.agent_sessions s ON s.game_id=g.id
     JOIN ctf.monitor_reviews r ON r.game_id=g.id AND r.session_id=s.id
     WHERE g.id=$1 AND g.status='active' AND g.execution_generation=$5
       AND s.id=$2 AND s.lease=$3 AND s.lease_until>now()
       AND r.id=$4 AND r.verdict='allow' AND r.admitted_revision IS NOT NULL
       AND r.execution_generation=$5 AND r.originating_lease=$3
       AND r.completed_revision IS NULL`,
    [input.gameId, input.sessionId, input.lease, input.reviewId, input.generation],
  );
  if (!rowCount) throw new GameError("This command permit has been revoked.", 409);
}

/** Return expired finalizations for caller-owned Sprite cleanup. Catch and capture are untouched. */
export async function expireFinalizations() {
  return withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `UPDATE ctf.games SET status='ended',finalization_token=NULL,finalization_lease_until=NULL,
        execution_generation=execution_generation+1,updated_at=now()
       WHERE status='finalizing' AND finalization_lease_until<=now() RETURNING id`,
    );
    return rows.map((row) => row.id);
  });
}
