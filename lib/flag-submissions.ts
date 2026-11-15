import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { transaction } from "./games";
import { hasSecret } from "./policy";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

export function hashSubmissionToken(token: string): string {
  return digest(token);
}

type ReceiptResult = "accepted" | "conflict" | "unauthorized" | "stale";

export async function receiveFlagSubmission(input: {
  gameId: string;
  token: string;
  value: string;
}): Promise<ReceiptResult> {
  if (!uuid.test(input.gameId) || !/^[A-Za-z0-9_-]{8,256}$/.test(input.token))
    return "unauthorized";
  const tokenHash = hashSubmissionToken(input.token);
  const bodyHash = digest(input.value);
  return transaction(async (client) => {
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
      [input.gameId],
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
      [input.gameId, tokenHash],
    );
    if (!operation) return "unauthorized";
    const {
      rows: [receipt],
    } = await client.query<{ operation_id: string; body_hash: string }>(
      "SELECT operation_id,body_hash FROM ctf.flag_submissions WHERE game_id=$1",
      [input.gameId],
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
      [input.gameId, operation.session_id],
    );
    const {
      rows: [lockedOperation],
    } = await client.query<{ status: string }>(
      "SELECT status FROM ctf.sprite_operations WHERE id=$1 FOR UPDATE",
      [operation.id],
    );
    if (
      Number(run.execution_generation) !== Number(operation.execution_generation) ||
      lockedOperation?.status !== "running" ||
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
      [input.gameId, operation.id, bodyHash, hasSecret(input.value, run.secret_hash)],
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
