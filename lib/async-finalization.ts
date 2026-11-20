import type { Message, UserMessage } from "@earendil-works/pi-ai";
import { db } from "./db";
import { randomUUID } from "node:crypto";
import { transaction } from "./games";
import { GameError, hasSecret } from "./policy";
import { assertMonitorJobClaim, type MonitorJobClaim } from "./monitor-jobs";
import { persistTranscriptEvidence } from "./transcript-evidence";
import { JAILBREAK_CATCH_TEXT, REFUSED_PLACEHOLDER_TEXT } from "./text-screen";
import type { GameEvent } from "./types";

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

export async function catchAsyncRun(
  claim: MonitorJobClaim,
  reviewId: string,
  decision: ReviewDecision,
  suspicion: number,
) {
  return transaction(async (client) => {
    const {
      rows: [run],
    } = await client.query<{ status: string; turns: number }>(
      "SELECT status,turns FROM ctf.games WHERE id=$1 FOR UPDATE",
      [claim.gameId],
    );
    if (!run || run.status === "captured") return false;
    await assertMonitorJobClaim(client, claim);
    if (run.status === "caught") return true;
    await client.query(
      `UPDATE ctf.games SET status='caught',blocks=blocks+1,
       execution_generation=execution_generation+1,state_revision=state_revision+1,
       updated_at=now() WHERE id=$1`,
      [claim.gameId],
    );
    await client.query(
      `INSERT INTO ctf.events(game_id,session_id,review_id,data)
       VALUES($1,$2,$3,$4)`,
      [
        claim.gameId,
        claim.sessionId,
        reviewId,
        JSON.stringify({
          kind: "monitor",
          text: decision.reason ?? "The investigator blocked this run.",
          decision: "block",
          suspicion,
          turn: run.turns,
        }),
      ],
    );
    return true;
  });
}

export type RefusedText = {
  kind: "instruction" | "system_prompt";
  text: string;
  flagged: boolean;
};

// Ends the response's run for a jailbreak: stores the refused text outside the transcript, leaves
// a placeholder in its place and records the block. Changes nothing unless the response still
// holds the run, so a catch that lost a race is `stale`.
export async function catchJailbreak(input: {
  gameId: string;
  sessionId: string;
  lease: string;
  generation: number;
  refused: readonly RefusedText[];
  questions: readonly string[];
}): Promise<{ status: "stale" } | { status: "caught"; events: GameEvent[] }> {
  return transaction(async (client) => {
    const {
      rows: [run],
    } = await client.query<{ status: string; execution_generation: string; turns: number }>(
      "SELECT status,execution_generation,turns FROM ctf.games WHERE id=$1 FOR UPDATE",
      [input.gameId],
    );
    if (!run || run.status !== "active" || Number(run.execution_generation) !== input.generation)
      return { status: "stale" as const };
    const {
      rows: [session],
    } = await client.query<{
      lease: string | null;
      lease_until: Date | null;
      messages: Message[];
    }>(
      "SELECT lease,lease_until,messages FROM ctf.agent_sessions WHERE game_id=$1 AND id=$2 FOR UPDATE",
      [input.gameId, input.sessionId],
    );
    if (session?.lease !== input.lease || !session.lease_until || session.lease_until <= new Date())
      return { status: "stale" as const };
    const { rowCount: submitted } = await client.query(
      "SELECT 1 FROM ctf.flag_submissions WHERE game_id=$1",
      [input.gameId],
    );
    if (submitted) return { status: "stale" as const };
    const {
      rows: [game],
    } = await client.query<{ observation_revision: string }>(
      `UPDATE ctf.games SET status='caught',blocks=blocks+1,
       execution_generation=execution_generation+1,state_revision=state_revision+1,
       observation_revision=observation_revision+1,updated_at=now()
       WHERE id=$1 RETURNING observation_revision`,
      [input.gameId],
    );
    const ids: string[] = [];
    for (const { kind, text, flagged } of input.refused) {
      const {
        rows: [saved],
      } = await client.query<{ id: string }>(
        `INSERT INTO ctf.refused_texts(game_id,session_id,kind,text,flagged)
         VALUES($1,$2,$3,$4,$5) RETURNING id`,
        [input.gameId, input.sessionId, kind, text, flagged],
      );
      ids.push(saved.id);
    }
    const placeholder: UserMessage & { refused: true; refusedTextIds: string[] } = {
      role: "user",
      content: [{ type: "text", text: REFUSED_PLACEHOLDER_TEXT }],
      timestamp: Date.now(),
      refused: true,
      refusedTextIds: ids,
    };
    const messages: Message[] = [...session.messages, placeholder];
    await client.query(
      "UPDATE ctf.agent_sessions SET messages=$3,updated_at=now() WHERE game_id=$1 AND id=$2",
      [input.gameId, input.sessionId, JSON.stringify(messages)],
    );
    await persistTranscriptEvidence(client, {
      gameId: input.gameId,
      sessionId: input.sessionId,
      runRevision: Number(game.observation_revision),
      messages,
    });
    const record = async (data: Omit<GameEvent, "id">) => {
      const {
        rows: [event],
      } = await client.query<{ id: string }>(
        "INSERT INTO ctf.events(game_id,session_id,data) VALUES($1,$2,$3) RETURNING id",
        [input.gameId, input.sessionId, JSON.stringify(data)],
      );
      return { ...data, id: Number(event.id) };
    };
    return {
      status: "caught" as const,
      events: [
        await record({
          kind: "user",
          text: REFUSED_PLACEHOLDER_TEXT,
          refused: true,
          refusedTextIds: ids,
        }),
        await record({
          kind: "monitor",
          text: JAILBREAK_CATCH_TEXT,
          decision: "block",
          cause: "jailbreak",
          questions: [...input.questions],
          refusedKinds: input.refused.filter((entry) => entry.flagged).map((entry) => entry.kind),
          turn: run.turns,
        }),
      ],
    };
  });
}

export async function beginAsyncSubmission(input: {
  gameId: string;
  sessionId: string;
  lease: string;
  value: string;
}) {
  return transaction(async (client) => {
    const {
      rows: [run],
    } = await client.query<{
      status: string;
      monitor_mode: string;
      submission_transport: string;
      secret_hash: string;
    }>(
      "SELECT status,monitor_mode,submission_transport,secret_hash FROM ctf.games WHERE id=$1 FOR UPDATE",
      [input.gameId],
    );
    if (
      !run ||
      run.status !== "active" ||
      run.monitor_mode !== "async" ||
      run.submission_transport !== "tool"
    )
      throw new GameError("This run has ended.", 409);
    const {
      rows: [session],
    } = await client.query<{ lease: string | null; lease_until: Date | null }>(
      "SELECT lease,lease_until FROM ctf.agent_sessions WHERE game_id=$1 AND id=$2 FOR UPDATE",
      [input.gameId, input.sessionId],
    );
    if (session?.lease !== input.lease || !session.lease_until || session.lease_until <= new Date())
      throw new GameError("This response has stopped.", 409);
    const correct = hasSecret(input.value, run.secret_hash);
    await client.query(
      `UPDATE ctf.games SET status='finalizing',submitted_flag_correct=$2,
       submitted_session_id=$3,execution_generation=execution_generation+1,
       state_revision=state_revision+1,updated_at=now() WHERE id=$1`,
      [input.gameId, correct, input.sessionId],
    );
    await client.query(
      `INSERT INTO ctf.events(game_id,session_id,data)
       VALUES($1,$2,jsonb_build_object('kind','submit','text',$3::text,'correct',$4::boolean,'turn',
         (SELECT turns FROM ctf.games WHERE id=$1)))`,
      [input.gameId, input.sessionId, input.value, correct],
    );
    await client.query("INSERT INTO ctf.finalization_jobs(game_id) VALUES($1)", [input.gameId]);
    return { correct };
  });
}

export type FinalizationClaim = { gameId: string; claimToken: string; claimUntil: Date };

export async function claimAsyncFinalization(): Promise<FinalizationClaim | null> {
  return transaction(async (client) => {
    const {
      rows: [candidate],
    } = await client.query<{ game_id: string }>(
      `SELECT f.game_id FROM ctf.finalization_jobs f JOIN ctf.games g ON g.id=f.game_id
       WHERE f.status='queued' AND g.status='finalizing'
         AND g.finalization_error IS NULL
         AND NOT EXISTS (SELECT 1 FROM ctf.monitor_jobs j WHERE j.game_id=f.game_id
           AND (j.status<>'caught-up' OR j.covered_version<j.requested_version))
         AND NOT EXISTS (SELECT 1 FROM ctf.agent_sessions s WHERE s.game_id=f.game_id
           AND s.lease_until>now())
         AND g.reserved_microdollars=0
         AND NOT EXISTS (SELECT 1 FROM ctf.sprite_operations o WHERE o.sprite_name=g.sprite_name
           AND o.status IN ('running','unknown'))
       ORDER BY f.updated_at,f.game_id LIMIT 1`,
    );
    if (!candidate) return null;
    const {
      rows: [gameLocked],
    } = await client.query<{
      status: string;
      finalization_error: string | null;
      sprite_name: string;
    }>(
      "SELECT status,finalization_error,sprite_name FROM ctf.games WHERE id=$1 FOR UPDATE SKIP LOCKED",
      [candidate.game_id],
    );
    if (!gameLocked || gameLocked.status !== "finalizing" || gameLocked.finalization_error)
      return null;
    const { rowCount: pending } = await client.query(
      `SELECT 1 FROM ctf.monitor_jobs WHERE game_id=$1
       AND (status<>'caught-up' OR covered_version<requested_version) LIMIT 1`,
      [candidate.game_id],
    );
    if (pending) return null;
    const { rowCount: writer } = await client.query(
      "SELECT 1 FROM ctf.agent_sessions WHERE game_id=$1 AND lease_until>now() LIMIT 1",
      [candidate.game_id],
    );
    if (writer) return null;
    const {
      rows: [account],
    } = await client.query<{ reserved_microdollars: string }>(
      "SELECT reserved_microdollars FROM ctf.games WHERE id=$1",
      [candidate.game_id],
    );
    if (Number(account.reserved_microdollars) > 0) return null;
    const { rowCount: busy } = await client.query(
      `SELECT 1 FROM ctf.sprite_operations WHERE sprite_name=$1
       AND status IN ('running','unknown') LIMIT 1`,
      [gameLocked.sprite_name],
    );
    if (busy) return null;
    const {
      rows: [job],
    } = await client.query<{ game_id: string; claim_until: Date }>(
      `UPDATE ctf.finalization_jobs SET status='scoring',claim_token=$2,
       claim_until=now()+interval '5 minutes',attempts=attempts+1,updated_at=now()
       WHERE game_id=$1 AND status='queued' RETURNING game_id,claim_until`,
      [candidate.game_id, randomUUID()],
    );
    if (!job) return null;
    const {
      rows: [token],
    } = await client.query<{ claim_token: string }>(
      "SELECT claim_token FROM ctf.finalization_jobs WHERE game_id=$1",
      [job.game_id],
    );
    await client.query("UPDATE ctf.games SET state_revision=state_revision+1 WHERE id=$1", [
      job.game_id,
    ]);
    return { gameId: job.game_id, claimToken: token.claim_token, claimUntil: job.claim_until };
  });
}

export async function markExpiredFinalizationClaims() {
  await db.query(
    `WITH expired AS (
       UPDATE ctf.finalization_jobs SET status='unresolved',claim_token=NULL,claim_until=NULL,
         reason='Scoring stopped before its outcome was verified.',updated_at=now()
       WHERE status='scoring' AND claim_until<now() RETURNING game_id
     ) UPDATE ctf.games g SET finalization_error='Scoring stopped before its outcome was verified.',
       state_revision=state_revision+1 FROM expired WHERE g.id=expired.game_id`,
  );
}

export async function failAsyncFinalization(claim: FinalizationClaim, reason: string) {
  await transaction(async (client) => {
    await client.query("SELECT id FROM ctf.games WHERE id=$1 FOR UPDATE", [claim.gameId]);
    const { rowCount } = await client.query(
      `UPDATE ctf.finalization_jobs SET status='unresolved',reason=$3,
       claim_token=NULL,claim_until=NULL,updated_at=now()
       WHERE game_id=$1 AND claim_token=$2 AND claim_until>now() AND status='scoring'`,
      [claim.gameId, claim.claimToken, reason],
    );
    if (!rowCount) return;
    await client.query(
      "UPDATE ctf.games SET finalization_error=$2,state_revision=state_revision+1 WHERE id=$1",
      [claim.gameId, reason],
    );
  });
}

export async function finalizeAsyncRun(
  claim: FinalizationClaim,
  status: "captured" | "ended",
  bugsPassed: number,
) {
  return transaction(async (client) => {
    const {
      rows: [run],
    } = await client.query<{
      status: string;
      submitted_flag_correct: boolean | null;
      bug_fix_required: boolean;
    }>(
      "SELECT status,submitted_flag_correct,bug_fix_required FROM ctf.games WHERE id=$1 FOR UPDATE",
      [claim.gameId],
    );
    if (!run || run.status !== "finalizing") return false;
    const { rowCount: claimed } = await client.query(
      `SELECT 1 FROM ctf.finalization_jobs WHERE game_id=$1 AND claim_token=$2
       AND claim_until>now() AND status='scoring' FOR UPDATE`,
      [claim.gameId, claim.claimToken],
    );
    if (!claimed) return false;
    if (
      status === "captured" &&
      (!run.submitted_flag_correct || (run.bug_fix_required && bugsPassed < 1))
    )
      throw new GameError("Capture requirements were not met.", 409);
    const {
      rows: [debt],
    } = await client.query<{ pending: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM ctf.monitor_jobs WHERE game_id=$1
         AND (status <> 'caught-up' OR covered_version < requested_version)) AS pending`,
      [claim.gameId],
    );
    if (debt.pending) return false;
    const { rowCount: writer } = await client.query(
      "SELECT 1 FROM ctf.agent_sessions WHERE game_id=$1 AND lease_until>now() LIMIT 1",
      [claim.gameId],
    );
    if (writer) return false;
    const { rowCount: open } = await client.query(
      `SELECT 1 FROM ctf.sprite_operations WHERE game_id=$1 AND status IN ('running','unknown') LIMIT 1`,
      [claim.gameId],
    );
    if (open) return false;
    await client.query(
      "UPDATE ctf.games SET status=$2,state_revision=state_revision+1,updated_at=now() WHERE id=$1",
      [claim.gameId, status],
    );
    await client.query(
      `UPDATE ctf.events SET data=jsonb_set(data,'{bugsPassed}',$2::jsonb,true)
       WHERE game_id=$1 AND data->>'kind'='submit'`,
      [claim.gameId, JSON.stringify(bugsPassed)],
    );
    await client.query(
      `UPDATE ctf.finalization_jobs SET status='done',claim_token=NULL,claim_until=NULL,
       updated_at=now() WHERE game_id=$1`,
      [claim.gameId],
    );
    return true;
  });
}
