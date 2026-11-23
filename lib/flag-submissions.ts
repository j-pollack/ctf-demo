import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { transaction } from "./games";
import { queueFinalReviews } from "./monitor-jobs";
import { hasSecret } from "./policy";
import { wakeWorker } from "./worker-wake";

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

export function hashSubmissionToken(token: string): string {
  return digest(token);
}

type ReceiptResult = "accepted" | "conflict" | "unauthorized" | "stale";

type Receipt = { result: ReceiptResult; promoted: boolean };

/** Accepts an upload while the run is active, whatever became of the command that held the token. */
export async function receiveFlagUpload(input: { token: string; value: string }): Promise<Receipt> {
  if (!/^[A-Za-z0-9_-]{8,256}$/.test(input.token))
    return { result: "unauthorized", promoted: false };
  const tokenHash = hashSubmissionToken(input.token);
  const bodyHash = digest(input.value);
  return transaction(async (client) => {
    // The token alone names the run. This read takes no lock; the run is rechecked after it is locked.
    const {
      rows: [operation],
    } = await client.query<{ id: string; game_id: string }>(
      "SELECT id,game_id FROM ctf.sprite_operations WHERE submission_token_hash=$1 AND kind='command'",
      [tokenHash],
    );
    if (!operation) return { result: "unauthorized", promoted: false };
    const gameId = operation.game_id;
    const {
      rows: [run],
    } = await client.query<{
      status: string;
      monitor_mode: string;
      submission_transport: string;
      secret_hash: string;
    }>(
      `SELECT status,monitor_mode,submission_transport,secret_hash
       FROM ctf.games WHERE id=$1 FOR UPDATE`,
      [gameId],
    );
    if (!run) return { result: "unauthorized", promoted: false };
    const {
      rows: [receipt],
    } = await client.query<{ operation_id: string; body_hash: string }>(
      "SELECT operation_id,body_hash FROM ctf.flag_submissions WHERE game_id=$1",
      [gameId],
    );
    if (receipt)
      return {
        result:
          receipt.operation_id === operation.id && receipt.body_hash === bodyHash
            ? "accepted"
            : "conflict",
        promoted: false,
      };
    if (
      run.status !== "active" ||
      run.monitor_mode !== "async" ||
      run.submission_transport !== "http"
    )
      return { result: "stale", promoted: false };
    await client.query(
      `INSERT INTO ctf.flag_submissions(game_id,operation_id,body_hash,correct)
       VALUES($1,$2,$3,$4)`,
      [gameId, operation.id, bodyHash, hasSecret(input.value, run.secret_hash)],
    );
    return {
      result: "accepted",
      promoted: (await promoteHttpSubmission(client, gameId)) === "promoted",
    };
  });
}

type PromotionResult = "promoted" | "pending" | "none";

/**
 * Grades the run's receipt once no command on its sprite is running or unknown, so a running
 * command's output still gets its flag check first. A receipt's command is on that sprite, so
 * then it has completed or been interrupted. Call after an upload, or after a command's outcome,
 * in the same transaction.
 */
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
  }>(
    `SELECT r.operation_id,r.correct,r.promoted_at,o.session_id
     FROM ctf.flag_submissions r JOIN ctf.sprite_operations o ON o.id=r.operation_id
     WHERE r.game_id=$1 FOR UPDATE OF r`,
    [gameId],
  );
  if (!receipt || receipt.promoted_at) return "none";
  if (run.status !== "active") return "pending";
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
  await queueFinalReviews(client, gameId);
  await client.query(
    "INSERT INTO ctf.finalization_jobs(game_id) VALUES($1) ON CONFLICT (game_id) DO NOTHING",
    [gameId],
  );
  void wakeWorker();
  return "promoted";
}
