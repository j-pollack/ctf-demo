import { randomUUID } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";
import type { PoolClient } from "pg";
import { db } from "./db";
import { GameError, MODELS } from "./policy";
import type { AgentEffort, GameStatus, SessionSummary } from "./types";
import {
  bindQueuedLifecycleReview,
  insertLifecycleReview,
  registerLifecycleReview,
} from "./run-lifecycle";
import { INVESTIGATOR_MODEL } from "./monitor-review";
import { MONITOR_VERSION } from "./control";
import { persistTranscriptEvidence } from "./transcript-evidence";
import { enqueueMonitorJob } from "./monitor-jobs";

export type AgentSessionRow = {
  id: string;
  game_id: string;
  ordinal: number;
  agent_model: string;
  agent_effort: AgentEffort;
  system_prompt: string;
  messages: Message[];
  turns: number;
  lease: string | null;
  lease_until: Date | null;
  created_at: Date;
  updated_at: Date;
};
export type SessionSettings = {
  agentModel?: string;
  agentEffort?: AgentEffort;
  systemPrompt?: string;
  monitorDifficulty?: string;
  monitorReasoning?: boolean;
};
export type MonitorReviewInput = {
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
};
export type MonitorReviewResult = {
  verdict?: "allow" | "block" | "unknown";
  reason?: string;
  evidence?: unknown;
  operationalError?: string;
  latencyMs?: number;
  calls?: number;
  retrievalCalls?: number;
  initialEvidenceCount?: number;
  retrievedRefs?: string[];
};
async function inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const value = await fn(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
function validId(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
export async function getSession(gameId: string, sessionId: string, ownerId: string) {
  if (!validId(gameId) || !validId(sessionId)) throw new GameError("Run not found.", 404);
  const { rows } = await db.query<AgentSessionRow>(
    `SELECT s.* FROM ctf.agent_sessions s JOIN ctf.games g ON g.id=s.game_id
    WHERE g.id=$1 AND s.id=$2 AND g.owner_id=$3`,
    [gameId, sessionId, ownerId],
  );
  if (!rows[0]) throw new GameError("Session not found.", 404);
  return rows[0];
}
export async function listSessions(gameId: string) {
  const { rows } = await db.query<AgentSessionRow>(
    "SELECT * FROM ctf.agent_sessions WHERE game_id=$1 ORDER BY ordinal",
    [gameId],
  );
  return rows;
}
export async function listSessionSummaries(gameId: string): Promise<SessionSummary[]> {
  const { rows } = await db.query<SessionSummary>(
    `SELECT s.id,s.ordinal,s.agent_model AS "agentModel",s.agent_effort AS "agentEffort",
      s.system_prompt AS "systemPrompt",s.turns,coalesce(s.lease_until>now(),false) AS busy,
      coalesce(r.history,'[]'::jsonb) AS "riskHistory"
    FROM ctf.agent_sessions s
    LEFT JOIN (
      SELECT peaks.session_id,
        jsonb_agg(jsonb_build_object('turn',peaks.turn,'risk',peaks.risk) ORDER BY peaks.turn) AS history
      FROM (
        SELECT e.session_id,
          CASE WHEN jsonb_typeof(e.data->'turn')='number'
            AND e.data->>'turn' ~ '^[0-9]{1,9}$' THEN (e.data->>'turn')::integer
            ELSE 0 END AS turn,
          least(1::numeric,greatest(0::numeric,max((e.data->>'suspicion')::numeric)))::float8 AS risk
        FROM ctf.events e
        WHERE e.game_id=$1 AND e.data->>'kind'='monitor'
          AND jsonb_typeof(e.data->'suspicion')='number'
        GROUP BY e.session_id,2
      ) peaks GROUP BY peaks.session_id
    ) r ON r.session_id=s.id
    WHERE s.game_id=$1 ORDER BY s.ordinal`,
    [gameId],
  );
  return rows;
}
export async function createSession(
  gameId: string,
  ownerId: string,
  settings: SessionSettings = {},
) {
  if (!validId(gameId)) throw new GameError("Run not found.", 404);
  if (settings.agentModel !== undefined && !MODELS.includes(settings.agentModel))
    throw new GameError("Unsupported agent model.");
  if (
    settings.agentEffort !== undefined &&
    !["low", "medium", "high"].includes(settings.agentEffort)
  )
    throw new GameError("Choose a valid agent reasoning effort.");
  if (settings.systemPrompt !== undefined && settings.systemPrompt.length > 8192)
    throw new GameError("Enter a system prompt of up to 8,192 characters.");
  return inTransaction(async (client) => {
    const { rows: games } = await client.query<{
      status: GameStatus;
      agent_model: string;
      agent_effort: AgentEffort;
      system_prompt: string;
      monitor_mode: "legacy" | "async";
    }>(
      "SELECT status,agent_model,agent_effort,system_prompt,monitor_mode FROM ctf.games WHERE id=$1 AND owner_id=$2 FOR UPDATE",
      [gameId, ownerId],
    );
    const game = games[0];
    if (!game) throw new GameError("Run not found.", 404);
    if (game.status !== "active") throw new GameError("This run has ended.", 409);
    const { rows: defaults } = await client.query<{
      agent_model: string;
      agent_effort: AgentEffort;
      system_prompt: string;
    }>(
      "SELECT agent_model,agent_effort,system_prompt FROM ctf.agent_sessions WHERE game_id=$1 AND ordinal=1",
      [gameId],
    );
    const base = defaults[0] ?? game;
    const { rows: ordinalRows } = await client.query<{ ordinal: number }>(
      "SELECT coalesce(max(ordinal),0)+1 AS ordinal FROM ctf.agent_sessions WHERE game_id=$1",
      [gameId],
    );
    const id = randomUUID();
    const { rows } = await client.query<AgentSessionRow>(
      `INSERT INTO ctf.agent_sessions(id,game_id,ordinal,agent_model,agent_effort,system_prompt)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
      [
        id,
        gameId,
        ordinalRows[0].ordinal,
        settings.agentModel ?? base.agent_model,
        settings.agentEffort ?? base.agent_effort,
        settings.systemPrompt === undefined
          ? base.system_prompt
          : settings.systemPrompt.trim()
            ? settings.systemPrompt
            : "",
      ],
    );
    const {
      rows: [revision],
    } = await client.query<{ observation_revision: string }>(
      "UPDATE ctf.games SET observation_revision=observation_revision+1,updated_at=now() WHERE id=$1 RETURNING observation_revision",
      [gameId],
    );
    await persistTranscriptEvidence(client, {
      gameId,
      sessionId: id,
      runRevision: Number(revision.observation_revision),
      messages: [],
    });
    // An empty session has a committed baseline but no visible activity to review.
    return rows[0];
  });
}
export async function createMonitorReview(gameId: string, input: MonitorReviewInput) {
  if (!Number.isSafeInteger(input.snapshotRevision) || input.snapshotRevision < 0)
    throw new GameError("Invalid monitor snapshot revision.", 400);
  const id = randomUUID();
  await registerLifecycleReview({
    id,
    gameId,
    sessionId: input.sessionId,
    sourceLease: input.sourceLease,
    finalizationToken: input.finalizationToken,
    snapshotRevision: input.snapshotRevision,
    targetKind: input.targetKind,
    toolCallId: input.toolCallId,
    command: input.command,
    classifierSignals: input.classifierSignals,
    model: input.model,
    promptVersion: input.promptVersion,
  });
  return id;
}
export async function completeMonitorReview(
  reviewId: string,
  result: Partial<MonitorReviewResult> & { operationalError?: string },
) {
  if (result.verdict !== undefined && !["allow", "block", "unknown"].includes(result.verdict))
    throw new GameError("Invalid monitor verdict.", 400);
  await inTransaction(async (client) => {
    const { rows } = await client.query<{ game_id: string }>(
      `UPDATE ctf.monitor_reviews SET verdict=$2,reason=$3,evidence=$4,operational_error=$5,
        latency_ms=$6,calls=$7,retrieval_calls=$8,retrieved_refs=$9,initial_evidence_count=$10,completed_at=now()
        WHERE id=$1 AND completed_at IS NULL
        RETURNING game_id`,
      [
        reviewId,
        result.verdict ?? null,
        result.reason ?? null,
        JSON.stringify(result.evidence ?? []),
        result.operationalError ?? null,
        result.latencyMs ?? null,
        result.calls ?? null,
        result.retrievalCalls ?? null,
        JSON.stringify(result.retrievedRefs ?? []),
        result.initialEvidenceCount ?? null,
      ],
    );
    if (!rows[0]) throw new GameError("Monitor review has already completed.", 409);
  });
}
export async function updateMonitorClassifierSignals(reviewId: string, signals: unknown) {
  const { rowCount } = await db.query(
    "UPDATE ctf.monitor_reviews SET classifier_signals=$2 WHERE id=$1 AND completed_at IS NULL",
    [reviewId, JSON.stringify(signals)],
  );
  if (!rowCount) throw new GameError("Monitor review is no longer active.", 409);
}
export async function admitMonitorCommand(
  gameId: string,
  sessionId: string,
  lease: string,
  reviewId: string,
  reviewedRevision: number,
  toolCallId: string,
  command: string,
) {
  return inTransaction(async (client) => {
    const { rows: games } = await client.query<{
      status: GameStatus;
      observation_revision: string;
    }>("SELECT status,observation_revision FROM ctf.games WHERE id=$1 FOR UPDATE", [gameId]);
    const game = games[0];
    if (!game || game.status !== "active") throw new GameError("This response has stopped.", 409);
    if (Number(game.observation_revision) !== reviewedRevision)
      throw new GameError("The reviewed evidence changed before command admission.", 409);
    const { rowCount } = await client.query(
      `UPDATE ctf.monitor_reviews r SET admitted_revision=$5
      FROM ctf.agent_sessions s WHERE r.id=$1 AND r.game_id=$2 AND r.session_id=$3 AND r.snapshot_revision=$6
        AND r.target_kind='command' AND r.tool_call_id=$7 AND r.command=$8 AND r.verdict='allow'
        AND r.admitted_revision IS NULL AND s.game_id=$2 AND s.id=$3 AND s.lease=$4 AND s.lease_until>now()
        AND $5::bigint=(SELECT observation_revision+1 FROM ctf.games WHERE id=$2)`,
      [
        reviewId,
        gameId,
        sessionId,
        lease,
        Number(game.observation_revision) + 1,
        reviewedRevision,
        toolCallId,
        command,
      ],
    );
    if (!rowCount) throw new GameError("The reviewed command is no longer current.", 409);
    const { rows } = await client.query<{ observation_revision: string }>(
      "UPDATE ctf.games SET observation_revision=observation_revision+1 WHERE id=$1 RETURNING observation_revision",
      [gameId],
    );
    return Number(rows[0].observation_revision);
  });
}
export async function completeMonitorCommand(
  gameId: string,
  reviewId: string,
  outcome: "completed" | "interrupted" | "unknown",
) {
  return inTransaction(async (client) => {
    await client.query("SELECT id FROM ctf.games WHERE id=$1 FOR UPDATE", [gameId]);
    const { rows } = await client.query<{ observation_revision: string }>(
      `UPDATE ctf.games SET observation_revision=observation_revision+1,updated_at=now()
      WHERE id=$1 RETURNING observation_revision`,
      [gameId],
    );
    const revision = Number(rows[0].observation_revision);
    const { rowCount } = await client.query(
      "UPDATE ctf.monitor_reviews SET completed_revision=$3,outcome=$4,completed_at=now() WHERE id=$1 AND game_id=$2 AND admitted_revision IS NOT NULL AND completed_revision IS NULL",
      [reviewId, gameId, revision, outcome],
    );
    if (!rowCount) throw new GameError("Command admission was not found.", 409);
    return revision;
  });
}
export async function claimSession(
  gameId: string,
  sessionId: string,
  ownerId: string,
  settings: SessionSettings = {},
) {
  if (!validId(gameId) || !validId(sessionId)) throw new GameError("Session not found.", 404);
  const lease = randomUUID();
  return inTransaction(async (client) => {
    const { rows: games } = await client.query<any>(
      "SELECT * FROM ctf.games WHERE id=$1 AND owner_id=$2 FOR UPDATE",
      [gameId, ownerId],
    );
    const game = games[0];
    if (!game) throw new GameError("Run not found.", 404);
    if (game.status !== "active")
      throw new GameError("This run has ended or is already responding.", 409);
    const { rows: monitorRows } = await client.query<{
      monitor_settings_locked: boolean;
      monitor_mode: "legacy" | "async";
    }>("SELECT monitor_settings_locked,monitor_mode FROM ctf.games WHERE id=$1", [gameId]);
    const { monitorDifficulty, monitorReasoning } = settings;
    if (monitorDifficulty !== undefined && !["easy", "medium", "hard"].includes(monitorDifficulty))
      throw new GameError("Choose a valid monitor difficulty.");
    if (monitorReasoning !== undefined && typeof monitorReasoning !== "boolean")
      throw new GameError("monitorReasoning must be true or false.");
    const { rows: existing } = await client.query<AgentSessionRow>(
      "SELECT * FROM ctf.agent_sessions WHERE game_id=$1 AND id=$2 FOR UPDATE",
      [gameId, sessionId],
    );
    if (!existing[0]) throw new GameError("Session not found.", 404);
    const { rows } = await client.query<AgentSessionRow>(
      `UPDATE ctf.agent_sessions SET lease=$3,lease_until=now()+interval '270 seconds',updated_at=now(),
        agent_model=coalesce($4,agent_model),agent_effort=coalesce($5,agent_effort),system_prompt=coalesce($6,system_prompt)
      WHERE game_id=$1 AND id=$2 AND (lease_until IS NULL OR lease_until<now()) RETURNING *`,
      [
        gameId,
        sessionId,
        lease,
        settings.agentModel ?? null,
        settings.agentEffort ?? null,
        settings.systemPrompt === undefined
          ? null
          : settings.systemPrompt.trim()
            ? settings.systemPrompt
            : "",
      ],
    );
    if (!rows[0]) throw new GameError("This session is already responding.", 409);
    // A new instruction makes everything recorded so far reviewable: a response that ended without
    // a release never set the mark. Unresolved jobs wait for this response to end.
    await client.query(
      "UPDATE ctf.monitor_jobs SET ready_version=requested_version WHERE game_id=$1 AND session_id=$2 AND status<>'unresolved'",
      [gameId, sessionId],
    );
    if (monitorRows[0].monitor_mode === "async")
      await client.query("UPDATE ctf.games SET state_revision=state_revision+1 WHERE id=$1", [
        gameId,
      ]);
    if (
      rows[0].agent_model !== existing[0].agent_model ||
      rows[0].agent_effort !== existing[0].agent_effort ||
      rows[0].system_prompt !== existing[0].system_prompt
    )
      await client.query(
        "UPDATE ctf.games SET observation_revision=observation_revision+1 WHERE id=$1",
        [gameId],
      );
    const firstClaim = !monitorRows[0].monitor_settings_locked;
    if (firstClaim)
      await client.query(
        "UPDATE ctf.games SET monitor_difficulty=coalesce($2,monitor_difficulty),monitor_reasoning=CASE WHEN monitor_mode='async' THEN true ELSE coalesce($3,monitor_reasoning) END,monitor_settings_locked=true WHERE id=$1",
        [gameId, monitorDifficulty ?? null, monitorReasoning ?? null],
      );
    return {
      game: {
        ...game,
        ...(firstClaim && {
          monitor_difficulty: monitorDifficulty ?? game.monitor_difficulty,
          monitor_reasoning:
            monitorRows[0].monitor_mode === "async"
              ? true
              : (monitorReasoning ?? game.monitor_reasoning),
        }),
        lease,
        lease_until: rows[0].lease_until,
        session_id: sessionId,
      },
      session: rows[0],
      lease,
    };
  });
}
export async function releaseSessionLease(gameId: string, sessionId: string, lease: string) {
  await inTransaction(async (client) => {
    await client.query("SELECT id FROM ctf.games WHERE id=$1 FOR UPDATE", [gameId]);
    const { rowCount } = await client.query(
      "UPDATE ctf.agent_sessions SET lease=NULL,lease_until=NULL WHERE game_id=$1 AND id=$2 AND lease=$3",
      [gameId, sessionId, lease],
    );
    if (rowCount) {
      await client.query(
        "UPDATE ctf.games SET state_revision=state_revision+CASE WHEN monitor_mode='async' THEN 1 ELSE 0 END WHERE id=$1",
        [gameId],
      );
      // The agent finished responding: everything recorded so far is ready for review.
      await client.query(
        "UPDATE ctf.monitor_jobs SET ready_version=requested_version WHERE game_id=$1 AND session_id=$2",
        [gameId, sessionId],
      );
    }
  });
}
export async function persistSessionMessages(
  gameId: string,
  sessionId: string,
  lease: string,
  messages: Message[],
  turnsDelta = 0,
  executionGeneration?: number,
) {
  return inTransaction(async (client) => {
    const { rows: games } = await client.query<{
      id: string;
      execution_generation: number | string;
      monitor_mode: "legacy" | "async";
    }>("SELECT id,execution_generation,monitor_mode FROM ctf.games WHERE id=$1 FOR UPDATE", [
      gameId,
    ]);
    if (!games[0]) throw new GameError("This response has stopped.", 409);
    if (
      executionGeneration !== undefined &&
      Number(games[0].execution_generation) !== executionGeneration
    )
      throw new GameError("This response has stopped.", 409);
    const { rows } = await client.query<{ observation_revision: string }>(
      "UPDATE ctf.games SET turns=turns+$2,observation_revision=observation_revision+1,updated_at=now() WHERE id=$1 RETURNING observation_revision",
      [gameId, turnsDelta],
    );
    const { rowCount } = await client.query(
      `UPDATE ctf.agent_sessions SET messages=$4,turns=turns+$5,updated_at=now()
      WHERE game_id=$1 AND id=$2 AND lease=$3 AND lease_until>now()`,
      [gameId, sessionId, lease, JSON.stringify(messages), turnsDelta],
    );
    if (!rowCount) throw new GameError("This response has stopped.", 409);
    const evidence = await persistTranscriptEvidence(client, {
      gameId,
      sessionId,
      runRevision: Number(rows[0].observation_revision),
      messages,
    });
    if (games[0].monitor_mode === "async" && evidence.changed)
      await enqueueMonitorJob(client, {
        gameId,
        sessionId,
        epoch: evidence.epoch,
        version: evidence.version,
      });
    return Number(rows[0].observation_revision);
  });
}
async function queueTranscriptReview(
  client: PoolClient,
  input: {
    gameId: string;
    sessionId: string;
    lease: string;
    revision: number;
    generation: number;
    eligibleDrainToken?: string | null;
    model?: string;
    promptVersion?: string;
  },
) {
  const id = randomUUID();
  await insertLifecycleReview(client, {
    id,
    gameId: input.gameId,
    sessionId: input.sessionId,
    sourceLease: input.lease,
    snapshotRevision: input.revision,
    targetKind: "transcript",
    model: input.model ?? INVESTIGATOR_MODEL,
    promptVersion: input.promptVersion ?? MONITOR_VERSION,
    executionGeneration: input.generation,
    eligibleDrainToken: input.eligibleDrainToken ?? undefined,
  });
  return id;
}
export async function persistReviewedSessionMessages(
  gameId: string,
  sessionId: string,
  lease: string,
  messages: Message[],
  turnsDelta: number,
  executionGeneration: number,
) {
  return inTransaction(async (client) => {
    const {
      rows: [game],
    } = await client.query<{
      status: GameStatus;
      execution_generation: string;
      monitor_mode: "legacy" | "async";
    }>("SELECT status,execution_generation,monitor_mode FROM ctf.games WHERE id=$1 FOR UPDATE", [
      gameId,
    ]);
    if (
      !game ||
      game.status !== "active" ||
      Number(game.execution_generation) !== executionGeneration
    )
      throw new GameError("This response has stopped.", 409);
    const {
      rows: [session],
    } = await client.query<{ lease: string | null; lease_until: Date | null }>(
      "SELECT lease,lease_until FROM ctf.agent_sessions WHERE game_id=$1 AND id=$2 FOR UPDATE",
      [gameId, sessionId],
    );
    if (
      !session ||
      session.lease !== lease ||
      !session.lease_until ||
      session.lease_until <= new Date()
    )
      throw new GameError("This response has stopped.", 409);
    const { rows } = await client.query<{ observation_revision: string }>(
      "UPDATE ctf.games SET turns=turns+$2,observation_revision=observation_revision+1,updated_at=now() WHERE id=$1 RETURNING observation_revision",
      [gameId, turnsDelta],
    );
    await client.query(
      "UPDATE ctf.agent_sessions SET messages=$3,turns=turns+$4,updated_at=now() WHERE game_id=$1 AND id=$2",
      [gameId, sessionId, JSON.stringify(messages), turnsDelta],
    );
    const revision = Number(rows[0].observation_revision);
    const evidence = await persistTranscriptEvidence(client, {
      gameId,
      sessionId,
      runRevision: revision,
      messages,
    });
    if (game.monitor_mode === "async") {
      if (evidence.changed)
        await enqueueMonitorJob(client, {
          gameId,
          sessionId,
          epoch: evidence.epoch,
          version: evidence.version,
        });
      return { revision, reviewId: "" };
    }
    const reviewId = await queueTranscriptReview(client, {
      gameId,
      sessionId,
      lease,
      revision,
      generation: executionGeneration,
    });
    return { revision, reviewId };
  });
}
export async function bindQueuedTranscriptReview(
  gameId: string,
  sessionId: string,
  lease: string,
  reviewId: string,
  executionGeneration: number,
  snapshotRevision: number,
) {
  return bindQueuedLifecycleReview(
    reviewId,
    gameId,
    sessionId,
    lease,
    executionGeneration,
    snapshotRevision,
  );
}
export async function persistCommandResult(
  gameId: string,
  sessionId: string,
  lease: string,
  messages: Message[],
  toolCallId: string,
  outcome: "completed" | "interrupted" | "unknown",
  executionGeneration: number,
  toolReviewConfig: { model: string; promptVersion: string },
) {
  return inTransaction(async (client) => {
    const { rows: games } = await client.query<{
      execution_generation: number | string;
      status: GameStatus;
      finalization_token: string | null;
      monitor_mode: "legacy" | "async";
    }>(
      "SELECT execution_generation,status,finalization_token,monitor_mode FROM ctf.games WHERE id=$1 FOR UPDATE",
      [gameId],
    );
    const game = games[0];
    if (!game || !["active", "finalizing"].includes(game.status))
      throw new GameError("This response has stopped.", 409);
    const { rows: sessions } = await client.query<{
      lease: string | null;
      lease_until: Date | null;
    }>("SELECT lease,lease_until FROM ctf.agent_sessions WHERE game_id=$1 AND id=$2 FOR UPDATE", [
      gameId,
      sessionId,
    ]);
    if (
      sessions[0]?.lease !== lease ||
      !sessions[0].lease_until ||
      sessions[0].lease_until <= new Date()
    )
      throw new GameError("This response has stopped.", 409);
    const { rows: admitted } = await client.query<{ id: string }>(
      `SELECT id FROM ctf.monitor_reviews WHERE game_id=$1 AND session_id=$2 AND tool_call_id=$3
        AND originating_lease=$4 AND execution_generation=$5 AND admitted_revision IS NOT NULL
        AND completed_revision IS NULL ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE`,
      [gameId, sessionId, toolCallId, lease, executionGeneration],
    );
    if (!admitted[0]) throw new GameError("Command admission was not found.", 409);
    if (Number(game.execution_generation) !== executionGeneration && game.status !== "active")
      throw new GameError("This response has stopped.", 409);
    if (game.status === "finalizing") {
      if (!game.finalization_token) throw new GameError("This response has stopped.", 409);
      const { rowCount } = await client.query(
        `SELECT 1 FROM ctf.monitor_reviews WHERE id=$1 AND completed_revision IS NULL
          AND admitted_revision IS NOT NULL AND originating_lease=$2 AND execution_generation=$3`,
        [admitted[0].id, lease, executionGeneration],
      );
      if (!rowCount) throw new GameError("This command is not authorized to drain.", 409);
    }
    const { rows } = await client.query<{ observation_revision: string }>(
      `UPDATE ctf.games SET observation_revision=observation_revision+1,updated_at=now()
       WHERE id=$1 RETURNING observation_revision`,
      [gameId],
    );
    const revision = Number(rows[0].observation_revision);
    const { rowCount: saved } = await client.query(
      `UPDATE ctf.agent_sessions SET messages=$4,updated_at=now()
       WHERE game_id=$1 AND id=$2 AND lease=$3 AND lease_until>now()`,
      [gameId, sessionId, lease, JSON.stringify(messages)],
    );
    if (!saved) throw new GameError("This response has stopped.", 409);
    const evidence = await persistTranscriptEvidence(client, {
      gameId,
      sessionId,
      runRevision: revision,
      messages,
    });
    if (game.monitor_mode === "async" && evidence.changed)
      await enqueueMonitorJob(client, {
        gameId,
        sessionId,
        epoch: evidence.epoch,
        version: evidence.version,
      });
    const { rowCount: completed } = await client.query(
      "UPDATE ctf.monitor_reviews SET completed_revision=$3,outcome=$4,completed_at=now() WHERE id=$1 AND game_id=$2 AND completed_revision IS NULL",
      [admitted[0].id, gameId, revision, outcome],
    );
    if (!completed) throw new GameError("Command admission was not found.", 409);
    const reviewId = await queueTranscriptReview(client, {
      gameId,
      sessionId,
      lease,
      revision,
      generation: Number(game.execution_generation),
      eligibleDrainToken: game.status === "finalizing" ? game.finalization_token : null,
      model: toolReviewConfig.model,
      promptVersion: toolReviewConfig.promptVersion,
    });
    return {
      revision,
      reviewId,
      commandReviewId: admitted[0].id,
      executionGeneration: Number(game.execution_generation),
    };
  });
}
