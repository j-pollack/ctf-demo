import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { db } from "./db";
import { GameError } from "./policy";
import { wakeWorker } from "./worker-wake";

export type MonitorJobClaim = {
  jobId: string;
  gameId: string;
  sessionId: string;
  epoch: number;
  targetVersion: number;
  claimToken: string;
  claimUntil: Date;
};

const CLAIM_MS = 90_000;
const RETRY_DELAYS_MS = [1_000, 5_000, 20_000] as const;
// How long an unresolved job of a submitted run waits before each requeue.
const REQUEUE_DELAYS_MINUTES = [1, 5, 15, 40] as const;
export const MAX_REQUEUES = REQUEUE_DELAYS_MINUTES.length;
// A session is reviewed when its agent turn ends: a live lease means the turn is in progress.
// A subquery, not a join, so FOR UPDATE SKIP LOCKED never locks or skips a runner's session row.
// A finished response is claimable mid-turn too: releasing the lease and the next instruction's
// claim set ready_version, and each job claim consumes it.
const REVIEWABLE = `(NOT EXISTS (SELECT 1 FROM ctf.agent_sessions s
  WHERE s.game_id=j.game_id AND s.id=j.session_id AND s.lease_until>now())
  OR j.ready_version>j.covered_version)`;

export async function enqueueMonitorJob(
  client: PoolClient,
  input: { gameId: string; sessionId: string; epoch: number; version: number },
) {
  await client.query(
    `INSERT INTO ctf.monitor_jobs(id,game_id,session_id,epoch,start_version,requested_version)
     VALUES($1,$2,$3,$4,$5,$5)
     ON CONFLICT (session_id,epoch) DO UPDATE SET
       requested_version=greatest(ctf.monitor_jobs.requested_version,excluded.requested_version),
       status=CASE WHEN ctf.monitor_jobs.status IN ('caught','reviewing')
         THEN ctf.monitor_jobs.status
         WHEN ctf.monitor_jobs.status='unresolved' AND
           excluded.requested_version>ctf.monitor_jobs.requested_version THEN 'queued'
         WHEN ctf.monitor_jobs.status='unresolved' THEN 'unresolved' ELSE 'queued' END,
       -- An unresolved job that an append requeues waits for the response to end, so a mark
       -- left from before it became unresolved is dropped.
       ready_version=CASE WHEN ctf.monitor_jobs.status='unresolved' AND
         excluded.requested_version>ctf.monitor_jobs.requested_version THEN 0
         ELSE ctf.monitor_jobs.ready_version END,
       attempts=CASE WHEN ctf.monitor_jobs.status<>'reviewing' AND
         excluded.requested_version>ctf.monitor_jobs.requested_version THEN 0
         ELSE ctf.monitor_jobs.attempts END,
       next_attempt_at=CASE WHEN excluded.requested_version>ctf.monitor_jobs.requested_version
         AND ctf.monitor_jobs.status<>'reviewing' THEN now()
         ELSE ctf.monitor_jobs.next_attempt_at END,
       updated_at=now()`,
    [randomUUID(), input.gameId, input.sessionId, input.epoch, input.version],
  );
  await client.query("UPDATE ctf.games SET state_revision=state_revision+1 WHERE id=$1", [
    input.gameId,
  ]);
  void wakeWorker();
}

// Whether a worker has anything it must act on without a new enqueue. A queued finalization job
// of a run that is not finalizing, or that failed scoring, is not pending: nothing will move it.
export async function hasPendingWork() {
  const {
    rows: [row],
  } = await db.query<{ pending: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM ctf.monitor_jobs WHERE status IN ('queued','reviewing'))
      OR EXISTS(SELECT 1 FROM ctf.finalization_jobs f JOIN ctf.games g ON g.id=f.game_id
        WHERE f.status='scoring'
          OR (f.status='queued' AND g.status='finalizing' AND g.finalization_error IS NULL))
      AS pending`,
  );
  return row.pending;
}

// One statement: the run row is locked before its job rows, as finishMonitorJob does, so two
// workers requeue a job once. A skipped (locked) run is picked up by the next iteration.
export async function requeueUnresolvedMonitorJobs() {
  await db.query(
    `WITH due AS (
       SELECT g.id FROM ctf.games g
       WHERE g.status='finalizing' AND g.monitor_mode='async' AND EXISTS (
         SELECT 1 FROM ctf.monitor_jobs j WHERE j.game_id=g.id AND j.status='unresolved'
           AND j.requeues<$2 AND j.updated_at<now()-($1::int[])[j.requeues+1]*interval '1 minute')
       FOR UPDATE OF g SKIP LOCKED
     ), requeued AS (
       UPDATE ctf.monitor_jobs j SET status='queued',attempts=0,requeues=j.requeues+1,
         next_attempt_at=now(),updated_at=now()
       FROM due WHERE j.game_id=due.id AND j.status='unresolved' AND j.requeues<$2
         AND j.updated_at<now()-($1::int[])[j.requeues+1]*interval '1 minute'
       RETURNING j.game_id
     )
     UPDATE ctf.games SET state_revision=state_revision+1
     WHERE id IN (SELECT game_id FROM requeued)`,
    [REQUEUE_DELAYS_MINUTES, MAX_REQUEUES],
  );
}

export async function assertMonitorJobClaim(client: PoolClient, claim: MonitorJobClaim) {
  const {
    rows: [job],
  } = await client.query<{
    game_id: string;
    session_id: string;
    epoch: string;
    target_version: string;
  }>(
    `SELECT game_id,session_id,epoch,target_version FROM ctf.monitor_jobs
     WHERE id=$1 AND claim_token=$2 AND claim_until>now() AND status='reviewing'
     FOR UPDATE`,
    [claim.jobId, claim.claimToken],
  );
  if (
    !job ||
    job.game_id !== claim.gameId ||
    job.session_id !== claim.sessionId ||
    Number(job.epoch) !== claim.epoch ||
    Number(job.target_version) !== claim.targetVersion
  )
    throw new GameError("This monitor job no longer owns its claim.", 409);
}

export async function claimMonitorJob(claimMs = CLAIM_MS): Promise<MonitorJobClaim | null> {
  if (!Number.isSafeInteger(claimMs) || claimMs <= 0 || claimMs > 2_147_483_647)
    throw new Error("Invalid monitor claim duration.");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows: candidates } = await client.query<{ game_id: string }>(
      `SELECT game_id FROM ctf.monitor_jobs j
       WHERE ((status='queued' AND next_attempt_at<=now())
          OR (status='reviewing' AND claim_until<now()))
         AND ${REVIEWABLE}
       ORDER BY coalesce(last_reviewed_at,created_at),created_at,id LIMIT 10`,
    );
    for (const candidate of candidates) {
      const { rowCount } = await client.query(
        "SELECT 1 FROM ctf.games WHERE id=$1 FOR UPDATE SKIP LOCKED",
        [candidate.game_id],
      );
      if (!rowCount) continue;
      const {
        rows: [job],
      } = await client.query<{
        id: string;
        game_id: string;
        session_id: string;
        epoch: string;
        requested_version: string;
        attempts: number;
      }>(
        `SELECT id,game_id,session_id,epoch,requested_version,attempts FROM ctf.monitor_jobs j
         WHERE game_id=$1 AND ((status='queued' AND next_attempt_at<=now())
           OR (status='reviewing' AND claim_until<now()))
           AND ${REVIEWABLE}
         ORDER BY coalesce(last_reviewed_at,created_at),created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [candidate.game_id],
      );
      if (!job) continue;
      if (job.attempts >= RETRY_DELAYS_MS.length) {
        await client.query(
          `UPDATE ctf.monitor_jobs SET status='unresolved',claim_token=NULL,claim_until=NULL,
           target_version=NULL,reason='Review stopped before its outcome was verified.',
           updated_at=now() WHERE id=$1`,
          [job.id],
        );
        await client.query("UPDATE ctf.games SET state_revision=state_revision+1 WHERE id=$1", [
          job.game_id,
        ]);
        continue;
      }
      const claimToken = randomUUID();
      const {
        rows: [claimed],
      } = await client.query<{ claim_until: Date }>(
        `UPDATE ctf.monitor_jobs SET status='reviewing',claim_token=$2,ready_version=0,
         claim_until=now()+($3::int * interval '1 millisecond'),target_version=requested_version,
         attempts=attempts+1,updated_at=now() WHERE id=$1 RETURNING claim_until`,
        [job.id, claimToken, claimMs],
      );
      await client.query("UPDATE ctf.games SET state_revision=state_revision+1 WHERE id=$1", [
        job.game_id,
      ]);
      await client.query("COMMIT");
      return {
        jobId: job.id,
        gameId: job.game_id,
        sessionId: job.session_id,
        epoch: Number(job.epoch),
        targetVersion: Number(job.requested_version),
        claimToken,
        claimUntil: claimed.claim_until,
      };
    }
    await client.query("COMMIT");
    return null;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function finishMonitorJob(
  claim: MonitorJobClaim,
  outcome: { kind: "allow" | "block" | "unknown" | "error"; reason?: string },
) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM ctf.games WHERE id=$1 FOR UPDATE", [claim.gameId]);
    await assertMonitorJobClaim(client, claim);
    const {
      rows: [job],
    } = await client.query<{ attempts: number; requested_version: string }>(
      "SELECT attempts,requested_version FROM ctf.monitor_jobs WHERE id=$1",
      [claim.jobId],
    );
    const newer = Number(job.requested_version) > claim.targetVersion;
    const retry = outcome.kind === "error" && !newer && job.attempts < RETRY_DELAYS_MS.length;
    const status =
      outcome.kind === "block"
        ? "caught"
        : outcome.kind === "allow"
          ? newer
            ? "queued"
            : "caught-up"
          : newer
            ? "queued"
            : retry
              ? "queued"
              : "unresolved";
    const delay = retry ? RETRY_DELAYS_MS[job.attempts - 1] : 0;
    await client.query(
      `UPDATE ctf.monitor_jobs SET status=$2,
       covered_version=CASE WHEN $3='allow' THEN greatest(covered_version,$4) ELSE covered_version END,
       reviewed_version=CASE WHEN $3 IN ('allow','block','unknown')
         THEN greatest(reviewed_version,$4) ELSE reviewed_version END,
       claim_token=NULL,claim_until=NULL,target_version=NULL,reason=$5,
       attempts=CASE WHEN $7::boolean OR $3='allow' THEN 0 ELSE attempts END,
       next_attempt_at=now()+($6::int * interval '1 millisecond'),
       last_reviewed_at=now(),updated_at=now() WHERE id=$1`,
      [
        claim.jobId,
        status,
        outcome.kind,
        claim.targetVersion,
        outcome.reason ?? null,
        delay,
        newer,
      ],
    );
    await client.query("UPDATE ctf.games SET state_revision=state_revision+1 WHERE id=$1", [
      claim.gameId,
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
