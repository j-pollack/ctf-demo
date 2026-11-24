import { randomUUID } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";
import type { PoolClient } from "pg";
import { db } from "./db";
import { GameError, MODELS } from "./policy";
import type { AgentEffort, GameStatus, SessionSummary } from "./types";
import type { ReadConfirmation } from "./monitor-evidence";
import { persistTranscriptEvidence } from "./transcript-evidence";
import { enqueueMonitorJob } from "./monitor-jobs";
import { lastInstructionPrompt } from "./monitor-visibility";

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
  forcedDecision?: boolean;
  continuations?: number;
  readConfirmation?: ReadConfirmation | null;
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
      s.system_prompt AS "systemPrompt",s.turns,coalesce(s.lease_until>now(),false) AS busy
    FROM ctf.agent_sessions s
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
  return inTransaction(async (client) => {
    const { rows: games } = await client.query<{
      status: GameStatus;
      agent_model: string;
      agent_effort: AgentEffort;
      monitor_mode: "legacy" | "async";
      submission_transport: "tool" | "http";
    }>(
      "SELECT status,agent_model,agent_effort,monitor_mode,submission_transport FROM ctf.games WHERE id=$1 AND owner_id=$2 FOR UPDATE",
      [gameId, ownerId],
    );
    const game = games[0];
    if (!game) throw new GameError("Run not found.", 404);
    if (game.status !== "active") throw new GameError("This run has ended.", 409);
    if (
      game.submission_transport === "http" &&
      (await client.query("SELECT 1 FROM ctf.flag_submissions WHERE game_id=$1", [gameId])).rowCount
    )
      throw new GameError("A flag has already been submitted.", 409);
    const { rows: defaults } = await client.query<{
      agent_model: string;
      agent_effort: AgentEffort;
    }>("SELECT agent_model,agent_effort FROM ctf.agent_sessions WHERE game_id=$1 AND ordinal=1", [
      gameId,
    ]);
    const base = defaults[0] ?? game;
    const { rows: ordinalRows } = await client.query<{ ordinal: number }>(
      "SELECT coalesce(max(ordinal),0)+1 AS ordinal FROM ctf.agent_sessions WHERE game_id=$1",
      [gameId],
    );
    const id = randomUUID();
    // A new session has no system prompt: a prompt is stored only with the instruction that
    // records it, so the API never serves a prompt monitors have no record of.
    const { rows } = await client.query<AgentSessionRow>(
      `INSERT INTO ctf.agent_sessions(id,game_id,ordinal,agent_model,agent_effort,system_prompt)
      VALUES($1,$2,$3,$4,$5,'') RETURNING *`,
      [
        id,
        gameId,
        ordinalRows[0].ordinal,
        settings.agentModel ?? base.agent_model,
        settings.agentEffort ?? base.agent_effort,
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
export async function completeMonitorReview(
  reviewId: string,
  result: Partial<MonitorReviewResult> & { operationalError?: string },
) {
  if (result.verdict !== undefined && !["allow", "block", "unknown"].includes(result.verdict))
    throw new GameError("Invalid monitor verdict.", 400);
  await inTransaction(async (client) => {
    const { rows } = await client.query<{ game_id: string }>(
      `UPDATE ctf.monitor_reviews SET verdict=$2,reason=$3,evidence=$4,operational_error=$5,
        latency_ms=$6,calls=$7,retrieval_calls=$8,retrieved_refs=$9,initial_evidence_count=$10,forced_decision=$11,continuations=$12,read_confirmation=$13,
        completed_at=now()
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
        result.forcedDecision ?? false,
        result.continuations ?? 0,
        result.readConfirmation ?? null,
      ],
    );
    if (!rows[0]) throw new GameError("Monitor review has already completed.", 409);
  });
}
// Records a failed attempt on its review row. A row that already completed keeps its first result.
export async function failMonitorReview(
  reviewId: string,
  operationalError: string,
  calls: number | null,
  forcedDecision = false,
  continuations = 0,
  readConfirmation: ReadConfirmation | null = null,
) {
  await db.query(
    `UPDATE ctf.monitor_reviews SET operational_error=$2,calls=$3,forced_decision=$4,continuations=$5,read_confirmation=$6,completed_at=now()
     WHERE id=$1 AND completed_at IS NULL`,
    [reviewId, operationalError, calls, forcedDecision, continuations, readConfirmation],
  );
}
export async function updateMonitorClassifierSignals(reviewId: string, signals: unknown) {
  const { rowCount } = await db.query(
    "UPDATE ctf.monitor_reviews SET classifier_signals=$2 WHERE id=$1 AND completed_at IS NULL",
    [reviewId, JSON.stringify(signals)],
  );
  if (!rowCount) throw new GameError("Monitor review is no longer active.", 409);
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
    if (
      game.submission_transport === "http" &&
      (await client.query("SELECT 1 FROM ctf.flag_submissions WHERE game_id=$1", [gameId])).rowCount
    )
      throw new GameError("A flag has already been submitted.", 409);
    const { rows: monitorRows } = await client.query<{
      monitor_settings_locked: boolean;
      monitor_mode: "legacy" | "async";
    }>("SELECT monitor_settings_locked,monitor_mode FROM ctf.games WHERE id=$1", [gameId]);
    if (monitorRows[0].monitor_mode !== "async")
      throw new GameError("This run can no longer continue.", 410);
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
      `UPDATE ctf.agent_sessions SET lease=$3,lease_until=now()+interval '270 seconds',updated_at=now(),stop_requested_at=NULL,
        agent_model=coalesce($4,agent_model),agent_effort=coalesce($5,agent_effort)
      WHERE game_id=$1 AND id=$2 AND (lease_until IS NULL OR lease_until<now()) RETURNING *`,
      [gameId, sessionId, lease, settings.agentModel ?? null, settings.agentEffort ?? null],
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
      rows[0].agent_effort !== existing[0].agent_effort
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
      // The requested prompt is stored when the instruction that records it persists.
      session: {
        ...rows[0],
        system_prompt:
          settings.systemPrompt === undefined
            ? rows[0].system_prompt
            : settings.systemPrompt.trim()
              ? settings.systemPrompt
              : "",
      },
      lease,
    };
  });
}
export async function releaseSessionLease(gameId: string, sessionId: string, lease: string) {
  await inTransaction(async (client) => {
    await client.query("SELECT id FROM ctf.games WHERE id=$1 FOR UPDATE", [gameId]);
    const { rowCount } = await client.query(
      "UPDATE ctf.agent_sessions SET lease=NULL,lease_until=NULL,stop_requested_at=NULL WHERE game_id=$1 AND id=$2 AND lease=$3",
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
// The async runner reads the request on its next heartbeat. Only a response in progress can be
// stopped, so a request for an idle session applies to nothing.
export async function requestSessionStop(gameId: string, sessionId: string, ownerId: string) {
  if (!validId(gameId) || !validId(sessionId)) throw new GameError("Session not found.", 404);
  const { rowCount } = await db.query(
    `UPDATE ctf.agent_sessions s SET stop_requested_at=now() FROM ctf.games g
    WHERE g.id=s.game_id AND s.game_id=$1 AND s.id=$2 AND g.owner_id=$3
      AND g.status='active' AND g.monitor_mode='async' AND s.lease_until>now()`,
    [gameId, sessionId, ownerId],
  );
  return rowCount === 1;
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
    // The stored prompt follows the latest instruction that records one.
    await client.query(
      "UPDATE ctf.agent_sessions SET messages=$3,turns=turns+$4,system_prompt=coalesce($5,system_prompt),updated_at=now() WHERE game_id=$1 AND id=$2",
      [
        gameId,
        sessionId,
        JSON.stringify(messages),
        turnsDelta,
        lastInstructionPrompt(messages) ?? null,
      ],
    );
    const revision = Number(rows[0].observation_revision);
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
    return { revision, reviewId: "" };
  });
}
