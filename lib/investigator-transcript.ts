// The investigator's own transcript: one row per model request, written as the review goes so that
// a worker that is killed still leaves every dispatched request on record. Diagnostics only: a
// failed write is logged and never fails the review, and nothing here is a decision input.
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { db } from "./db";
import { diagnosticText, providerTranscript } from "./inference";
import type { ForceCause } from "./investigator-force";

// Rows are kept for good, for every review, success or failure (the user's rule, 2026-11-24).
// How long the end of a review waits for its writes before it goes on.
const TRANSCRIPT_WAIT_MS = 5_000;

type WireMessage = ReturnType<typeof providerTranscript>["messages"][number];

function log(event: string, fields: Record<string, unknown>) {
  console.error(JSON.stringify({ event, timestamp: new Date().toISOString(), ...fields }));
}

// Messages new since the last stored request. The previous response is left out: it is stored once,
// in its own row's `response`.
const fresh = (wire: WireMessage[], from: number) =>
  wire.slice(from).filter((message) => message.role !== "assistant");

export function createTranscriptRecorder(ids: { reviewId: string; gameId: string; model: string }) {
  let chain: Promise<void> = Promise.resolve();
  let stored = 0;
  let last = 0;
  // The request whose response has not been stored yet. A refused request never holds it.
  let token: number | undefined;
  const write = (seq: number, sql: string, params: unknown[]) => {
    chain = chain
      .then(() => db.query(sql, params))
      .then(
        () => undefined,
        (error: unknown) =>
          log("investigator.transcript.failed", {
            reviewId: ids.reviewId,
            seq,
            error: diagnosticText(error instanceof Error ? error.message : error),
          }),
      );
  };
  const wire = (messages: readonly Message[]) => providerTranscript([...messages], ids.model);
  return {
    dispatched(seq: number, messages: readonly Message[], forced: ForceCause | undefined) {
      const request = wire(messages);
      const delta = fresh(request.messages, stored);
      stored = request.messages.length;
      token = seq;
      last = seq;
      const tools = request.tools ?? [];
      write(
        seq,
        `INSERT INTO ctf.investigator_requests(review_id,game_id,seq,tools,tool_schemas,forced,messages)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          ids.reviewId,
          ids.gameId,
          seq,
          tools.map((tool) => tool.function.name),
          seq === 1 ? JSON.stringify(tools) : null,
          forced ?? null,
          JSON.stringify(delta),
        ],
      );
    },
    reserved(inferenceId: string, maxTokens: number) {
      if (token === undefined) return;
      write(
        token,
        "UPDATE ctf.investigator_requests SET inference_id=$3,max_tokens=$4 WHERE review_id=$1 AND seq=$2",
        [ids.reviewId, token, inferenceId, maxTokens],
      );
    },
    responded(message: AssistantMessage) {
      if (token === undefined) return;
      const seq = token;
      token = undefined;
      const failed = message.stopReason === "error" || message.stopReason === "aborted";
      write(
        seq,
        `UPDATE ctf.investigator_requests SET response=$3,stop_reason=$4,usage=$5,error=$6,
         completed_at=now() WHERE review_id=$1 AND seq=$2`,
        [
          ids.reviewId,
          seq,
          failed ? null : JSON.stringify(wire([message]).messages[0]),
          failed ? "error" : message.stopReason,
          JSON.stringify(message.usage),
          message.errorMessage ?? null,
        ],
      );
    },
    // Writes the tool results after the last response and waits a bounded time for every write.
    async close(messages: readonly Message[]) {
      if (token !== undefined) {
        write(
          token,
          `UPDATE ctf.investigator_requests SET stop_reason='error',
           error='The request ended without a response.',completed_at=now()
           WHERE review_id=$1 AND seq=$2 AND completed_at IS NULL`,
          [ids.reviewId, token],
        );
        token = undefined;
      }
      if (last > 0)
        write(
          last,
          "UPDATE ctf.investigator_requests SET trailing_results=$3 WHERE review_id=$1 AND seq=$2",
          [ids.reviewId, last, JSON.stringify(fresh(wire(messages).messages, stored))],
        );
      let timer: NodeJS.Timeout | undefined;
      const finished = await Promise.race([
        chain.then(() => true),
        new Promise<false>(
          (resolve) => (timer = setTimeout(() => resolve(false), TRANSCRIPT_WAIT_MS)),
        ),
      ]);
      clearTimeout(timer);
      if (!finished)
        log("investigator.transcript.timeout", {
          reviewId: ids.reviewId,
          waitMs: TRANSCRIPT_WAIT_MS,
          message: "Transcript writes did not finish in time. Transcript rows may be missing.",
        });
    },
  };
}
