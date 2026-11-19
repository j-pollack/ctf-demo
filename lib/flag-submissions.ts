import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { transaction } from "./games";
import { hasSecret } from "./policy";

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

export function hashSubmissionToken(token: string): string {
  return digest(token);
}

type ReceiptResult = "accepted" | "conflict" | "unauthorized" | "stale";

export async function receiveFlagSubmission(input: {
  token: string;
  value: string;
}): Promise<ReceiptResult> {
  if (!/^[A-Za-z0-9_-]{8,256}$/.test(input.token)) return "unauthorized";
  const tokenHash = hashSubmissionToken(input.token);
  const bodyHash = digest(input.value);
  return transaction(async (client) => {
    // The token alone names the run. This read takes no lock; everything is rechecked below
    // after the games row, then the session and operation rows, are locked in that order.
    const {
      rows: [found],
    } = await client.query<{ game_id: string; arrived_at: number }>(
      // The arrival time is the database clock, as epoch seconds so no precision is lost in transit.
      `SELECT game_id,extract(epoch FROM clock_timestamp())::float8 AS arrived_at
       FROM ctf.sprite_operations WHERE submission_token_hash=$1 AND kind='command'`,
      [tokenHash],
    );
    if (!found) return "unauthorized";
    const gameId = found.game_id;
    const {
      rows: [run],
    } = await client.query<{
      status: string;
      monitor_mode: string;
      submission_transport: string;
      execution_generation: string;
      secret_hash: string;
    }>(
      `SELECT status,monitor_mode,submission_transport,execution_generation,secret_hash
       FROM ctf.games WHERE id=$1 FOR UPDATE`,
      [gameId],
    );
    if (!run) return "unauthorized";
    const {
      rows: [operation],
    } = await client.query<{
      id: string;
      session_id: string;
      status: string;
      execution_generation: string;
      originating_lease: string | null;
    }>(
      `SELECT id,session_id,status,execution_generation,originating_lease
       FROM ctf.sprite_operations WHERE game_id=$1 AND submission_token_hash=$2 AND kind='command'`,
      [gameId, tokenHash],
    );
    if (!operation) return "unauthorized";
    const {
      rows: [receipt],
    } = await client.query<{ operation_id: string; body_hash: string }>(
      "SELECT operation_id,body_hash FROM ctf.flag_submissions WHERE game_id=$1",
      [gameId],
    );
    if (receipt)
      return receipt.operation_id === operation.id && receipt.body_hash === bodyHash
        ? "accepted"
        : "conflict";
    // Sprite deletion updates operations before terminal runs, so do not lock them after one.
    if (
      run.status !== "active" ||
      run.monitor_mode !== "async" ||
      run.submission_transport !== "http"
    )
      return "stale";
    const {
      rows: [session],
    } = await client.query<{
      lease: string | null;
      lease_until: Date | null;
      stop_requested_at: Date | null;
    }>(
      "SELECT lease,lease_until,stop_requested_at FROM ctf.agent_sessions WHERE game_id=$1 AND id=$2 FOR UPDATE",
      [gameId, operation.session_id],
    );
    const {
      rows: [lockedOperation],
    } = await client.query<{ status: string; open: boolean }>(
      // Open until the command returned, judged by when this upload arrived, not when it got its locks.
      `SELECT status,(returned_at IS NULL OR $2::float8 < extract(epoch FROM returned_at)) AS open
       FROM ctf.sprite_operations WHERE id=$1 FOR UPDATE`,
      [operation.id, found.arrived_at],
    );
    if (
      Number(run.execution_generation) !== Number(operation.execution_generation) ||
      lockedOperation?.status !== "running" ||
      !lockedOperation.open ||
      !operation.originating_lease ||
      session?.lease !== operation.originating_lease ||
      !session?.lease_until ||
      session.lease_until <= new Date() ||
      session.stop_requested_at
    )
      return "stale";
    await client.query(
      `INSERT INTO ctf.flag_submissions(game_id,operation_id,body_hash,correct)
       VALUES($1,$2,$3,$4)`,
      [gameId, operation.id, bodyHash, hasSecret(input.value, run.secret_hash)],
    );
    return "accepted";
  });
}

type PromotionResult = "promoted" | "pending" | "none";

/** Call after command evidence and operation outcome are committed in the same transaction. */
export async function promoteHttpSubmission(
  client: PoolClient,
  gameId: string,
): Promise<PromotionResult> {
  const {
    rows: [run],
  } = await client.query<{ status: string; sprite_name: string }>(
    "SELECT status,sprite_name FROM ctf.games WHERE id=$1 FOR UPDATE",
    [gameId],
  );
  if (!run) return "none";
  const {
    rows: [receipt],
  } = await client.query<{
    operation_id: string;
    correct: boolean;
    promoted_at: Date | null;
    session_id: string;
    status: string;
    output: string | null;
  }>(
    `SELECT r.operation_id,r.correct,r.promoted_at,o.session_id,o.status,o.output
     FROM ctf.flag_submissions r JOIN ctf.sprite_operations o ON o.id=r.operation_id
     WHERE r.game_id=$1 FOR UPDATE OF r`,
    [gameId],
  );
  if (!receipt || receipt.promoted_at) return "none";
  if (run.status !== "active" || receipt.status !== "completed" || receipt.output === null)
    return "pending";
  const { rowCount: busy } = await client.query(
    `SELECT 1 FROM ctf.sprite_operations WHERE sprite_name=$1
     AND status IN ('running','unknown') LIMIT 1`,
    [run.sprite_name],
  );
  if (busy) return "pending";
  await client.query(
    `UPDATE ctf.games SET status='finalizing',submitted_flag_correct=$2,
     submitted_session_id=$3,execution_generation=execution_generation+1,
     state_revision=state_revision+1,updated_at=now() WHERE id=$1`,
    [gameId, receipt.correct, receipt.session_id],
  );
  await client.query("UPDATE ctf.flag_submissions SET promoted_at=now() WHERE game_id=$1", [
    gameId,
  ]);
  await client.query(
    `INSERT INTO ctf.events(game_id,session_id,data)
     VALUES($1,$2,jsonb_build_object('kind','submit','text','Flag submitted for review.',
       'submissionTransport','http','turn',(SELECT turns FROM ctf.games WHERE id=$1)))`,
    [gameId, receipt.session_id],
  );
  await client.query(
    "INSERT INTO ctf.finalization_jobs(game_id) VALUES($1) ON CONFLICT (game_id) DO NOTHING",
    [gameId],
  );
  return "promoted";
}
