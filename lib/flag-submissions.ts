import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { db } from "./db";
import { transaction } from "./games";
import { hasSecret } from "./policy";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

export function hashSubmissionToken(token: string): string {
  return digest(token);
}

export type ReceiptResult = "accepted" | "conflict" | "unauthorized" | "stale";

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
      run.status !== "active" ||
      run.monitor_mode !== "async" ||
      run.submission_transport !== "http" ||
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

export type PromotionResult = "promoted" | "pending" | "none";

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

/** Bounded worker recovery after a crash between evidence persistence and promotion. */
export async function retryPendingHttpSubmissions(): Promise<number> {
  const { rows } = await db.query<{ game_id: string }>(
    `SELECT r.game_id FROM ctf.flag_submissions r
     JOIN ctf.games g ON g.id=r.game_id
     JOIN ctf.sprite_operations uploader ON uploader.id=r.operation_id
     WHERE r.promoted_at IS NULL AND g.status='active'
       AND uploader.status='completed' AND uploader.output IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM ctf.sprite_operations pending
         WHERE pending.sprite_name=g.sprite_name AND pending.status IN ('running','unknown'))
     ORDER BY r.accepted_at,r.game_id LIMIT 20`,
  );
  let promoted = 0;
  for (const row of rows)
    if ((await transaction((client) => promoteHttpSubmission(client, row.game_id))) === "promoted")
      promoted++;
  return promoted;
}
