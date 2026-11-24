// Prints the investigator's stored transcript of one review, or of every review of one run.
// Usage: DATABASE_URL=... node --import tsx scripts/investigator-transcript.ts <reviewId | gameId>
// Reads in a READ ONLY transaction. The output can hold a player's transcript: keep it private.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RequestRow = {
  seq: number;
  tools: string[];
  forced: string | null;
  stop_reason: string | null;
  max_tokens: number | null;
  usage: unknown;
  cost: string | null;
  error: string | null;
  messages: unknown;
  response: unknown;
  trailing: unknown;
};

export async function printInvestigatorTranscript(
  client: PoolClient,
  id: string,
  write: (line: string) => void,
) {
  if (!UUID.test(id)) throw new Error("Give a review id or a run id.");
  await client.query("BEGIN READ ONLY");
  try {
    const { rows: reviews } = await client.query<{
      id: string;
      game_id: string;
      session_id: string;
      prompt_version: string;
      verdict: string | null;
      operational_error: string | null;
    }>(
      `SELECT id,game_id,session_id,prompt_version,verdict,operational_error FROM ctf.monitor_reviews
       WHERE id=$1 OR game_id=$1 ORDER BY created_at,id`,
      [id],
    );
    if (!reviews.length) write("No review or run has this id.");
    for (const review of reviews) {
      write(
        `review ${review.id} run ${review.game_id} session ${review.session_id} version ${review.prompt_version} verdict ${review.verdict ?? "-"}${review.operational_error ? ` error ${review.operational_error}` : ""}`,
      );
      const { rows } = await client.query<RequestRow>(
        `SELECT r.seq,r.tools,r.forced,r.stop_reason,r.max_tokens,r.usage,i.cost::text AS cost,r.error,
           r.messages,r.response,r.trailing_results AS trailing
         FROM ctf.investigator_requests r LEFT JOIN ctf.inference i ON i.id=r.inference_id
         WHERE r.review_id=$1 ORDER BY r.seq`,
        [review.id],
      );
      if (!rows.length) write("  no stored requests");
      for (const row of rows) {
        write(
          `  #${row.seq} tools=${row.tools.join(",")} forced=${row.forced ?? "-"} stop=${row.stop_reason ?? "-"} max_tokens=${row.max_tokens ?? "-"} cost_microdollars=${row.cost ?? "-"} usage=${JSON.stringify(row.usage)}`,
        );
        if (row.error) write(`  error: ${row.error}`);
        write(`  messages: ${JSON.stringify(row.messages, null, 2)}`);
        if (row.response) write(`  response: ${JSON.stringify(row.response, null, 2)}`);
        if (row.trailing) write(`  trailing: ${JSON.stringify(row.trailing, null, 2)}`);
      }
    }
  } finally {
    await client.query("ROLLBACK");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Set DATABASE_URL explicitly.");
  const pool = new Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  try {
    await printInvestigatorTranscript(client, process.argv[2] ?? "", (line) => console.log(line));
  } finally {
    client.release();
    await pool.end();
  }
}
