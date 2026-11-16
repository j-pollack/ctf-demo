import { randomBytes, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Message } from "@earendil-works/pi-ai";
import type { PoolClient } from "pg";
import { db } from "./db";
import { transaction } from "./games";
import { enqueueMonitorJob } from "./monitor-jobs";
import { GameError } from "./policy";
import { persistTranscriptEvidence } from "./transcript-evidence";
import { destroyEnvironment } from "./sprites";
import { hashSubmissionToken, promoteHttpSubmission } from "./flag-submissions";

export type CommandDispatch = { id: string; generation: number; submissionToken?: string };

function mergeCommandResult(
  current: Message[],
  incoming: Message[],
  toolCallId: string,
  output: string,
): Message[] {
  const currentIsPrefix =
    current.length <= incoming.length &&
    current.every((message, index) => isDeepStrictEqual(message, incoming[index]));
  const incomingResult = incoming.find(
    (message) => message.role === "toolResult" && message.toolCallId === toolCallId,
  );
  const result = incomingResult ?? {
    role: "toolResult" as const,
    toolCallId,
    toolName: "sprite_exec",
    content: [{ type: "text" as const, text: output }],
    isError: true,
    timestamp: Date.now(),
  };
  if (currentIsPrefix) return incomingResult ? incoming : [...incoming, result];
  const existingIndex = current.findIndex(
    (message) => message.role === "toolResult" && message.toolCallId === toolCallId,
  );
  if (existingIndex >= 0)
    return incomingResult
      ? current.map((message, index) => (index === existingIndex ? incomingResult : message))
      : current;
  const callIndex = current.findIndex(
    (message) =>
      message.role === "assistant" &&
      message.content.some((part) => part.type === "toolCall" && part.id === toolCallId),
  );
  const assistant = callIndex < 0 ? null : current[callIndex];
  const callIds =
    assistant?.role === "assistant"
      ? assistant.content.filter((part) => part.type === "toolCall").map((part) => part.id)
      : [];
  const targetOrder = callIds.indexOf(toolCallId);
  let insertAt = callIndex < 0 ? current.length : callIndex + 1;
  if (targetOrder >= 0) {
    for (let index = callIndex + 1; index < current.length; index++) {
      const message = current[index];
      if (message.role !== "toolResult") break;
      const existingOrder = callIds.indexOf(message.toolCallId);
      if (existingOrder > targetOrder) break;
      insertAt = index + 1;
    }
  }
  return [...current.slice(0, insertAt), result, ...current.slice(insertAt)];
}

async function lockSprite(client: PoolClient, spriteName: string) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,9124))", [spriteName]);
}

export async function dispatchAsyncCommand(input: {
  gameId: string;
  sessionId: string;
  lease: string;
  toolCallId: string;
  command: string;
  generation: number;
}): Promise<CommandDispatch> {
  return transaction(async (client) => {
    const {
      rows: [locator],
    } = await client.query<{ sprite_name: string }>(
      "SELECT sprite_name FROM ctf.games WHERE id=$1",
      [input.gameId],
    );
    if (!locator) throw new GameError("This response has stopped.", 409);
    await lockSprite(client, locator.sprite_name);
    const {
      rows: [run],
    } = await client.query<{
      status: string;
      monitor_mode: string;
      submission_transport: "tool" | "http";
      execution_generation: string;
      sprite_name: string;
    }>(
      "SELECT status,monitor_mode,submission_transport,execution_generation,sprite_name FROM ctf.games WHERE id=$1 FOR UPDATE",
      [input.gameId],
    );
    if (
      !run ||
      run.status !== "active" ||
      run.monitor_mode !== "async" ||
      Number(run.execution_generation) !== input.generation
    )
      throw new GameError("This response has stopped.", 409);
    if (
      run.submission_transport === "http" &&
      (await client.query("SELECT 1 FROM ctf.flag_submissions WHERE game_id=$1", [input.gameId]))
        .rowCount
    )
      throw new GameError("A flag has already been submitted.", 409);
    const {
      rows: [session],
    } = await client.query<{ lease: string | null; lease_until: Date | null }>(
      "SELECT lease,lease_until FROM ctf.agent_sessions WHERE game_id=$1 AND id=$2 FOR UPDATE",
      [input.gameId, input.sessionId],
    );
    if (session?.lease !== input.lease || !session.lease_until || session.lease_until <= new Date())
      throw new GameError("This response has stopped.", 409);
    const { rowCount: exclusive } = await client.query(
      `SELECT 1 FROM ctf.sprite_operations WHERE sprite_name=$1
       AND kind IN ('score','restore','delete') AND status IN ('running','unknown') LIMIT 1`,
      [run.sprite_name],
    );
    if (exclusive) throw new GameError("The environment is being finalized.", 409);
    const id = randomUUID();
    const submissionToken =
      run.submission_transport === "http" ? randomBytes(32).toString("base64url") : undefined;
    await client.query(
      `INSERT INTO ctf.sprite_operations
       (id,sprite_name,game_id,session_id,tool_call_id,kind,command,execution_generation,submission_token_hash,originating_lease)
       VALUES($1,$2,$3,$4,$5,'command',$6,$7,$8,$9)`,
      [
        id,
        run.sprite_name,
        input.gameId,
        input.sessionId,
        input.toolCallId,
        input.command,
        input.generation,
        submissionToken ? hashSubmissionToken(submissionToken) : null,
        submissionToken ? input.lease : null,
      ],
    );
    return { id, generation: input.generation, ...(submissionToken && { submissionToken }) };
  });
}

export async function completeAsyncCommand(input: {
  dispatchId: string;
  gameId: string;
  sessionId: string;
  messages: Message[];
  outcome: "completed" | "interrupted" | "unknown";
  output: string;
}) {
  return transaction(async (client) => {
    const {
      rows: [run],
    } = await client.query<{
      observation_revision: string;
      monitor_mode: string;
    }>("SELECT observation_revision,monitor_mode FROM ctf.games WHERE id=$1 FOR UPDATE", [
      input.gameId,
    ]);
    if (!run || run.monitor_mode !== "async") throw new GameError("Run not found.", 404);
    const {
      rows: [operation],
    } = await client.query<{ status: string; output: string | null; tool_call_id: string }>(
      `SELECT status,output,tool_call_id FROM ctf.sprite_operations WHERE id=$1 AND game_id=$2
       AND session_id=$3 AND kind='command' FOR UPDATE`,
      [input.dispatchId, input.gameId, input.sessionId],
    );
    const resolvingUnknown = operation?.status === "unknown" && input.outcome === "completed";
    if (
      !operation ||
      (operation.output !== null && !resolvingUnknown) ||
      (!["running", "interrupted"].includes(operation.status) && !resolvingUnknown)
    )
      throw new GameError("Command dispatch was not found.", 409);
    const {
      rows: [session],
    } = await client.query<{ messages: Message[] }>(
      "SELECT messages FROM ctf.agent_sessions WHERE game_id=$1 AND id=$2 FOR UPDATE",
      [input.gameId, input.sessionId],
    );
    if (!session) throw new GameError("Session not found.", 404);
    const messages = mergeCommandResult(
      session.messages,
      input.messages,
      operation.tool_call_id,
      input.output,
    );
    const {
      rows: [revision],
    } = await client.query<{ observation_revision: string }>(
      `UPDATE ctf.games SET observation_revision=observation_revision+1,updated_at=now()
       WHERE id=$1 RETURNING observation_revision`,
      [input.gameId],
    );
    await client.query(
      "UPDATE ctf.agent_sessions SET messages=$3,updated_at=now() WHERE game_id=$1 AND id=$2",
      [input.gameId, input.sessionId, JSON.stringify(messages)],
    );
    await client.query(
      `UPDATE ctf.sprite_operations SET status=$2,output=$3,completed_at=now()
       WHERE id=$1`,
      [input.dispatchId, input.outcome, input.output],
    );
    const {
      rows: [event],
    } = await client.query<{ id: string; data: { kind: "tool"; text: string; turn: number } }>(
      `INSERT INTO ctf.events(game_id,session_id,data)
       VALUES($1,$2,jsonb_build_object('kind','tool','text',$3::text,'turn',
         (SELECT turns FROM ctf.games WHERE id=$1))) RETURNING id,data`,
      [input.gameId, input.sessionId, input.output],
    );
    const evidence = await persistTranscriptEvidence(client, {
      gameId: input.gameId,
      sessionId: input.sessionId,
      runRevision: Number(revision.observation_revision),
      messages,
    });
    if (evidence.changed)
      await enqueueMonitorJob(client, {
        gameId: input.gameId,
        sessionId: input.sessionId,
        epoch: evidence.epoch,
        version: evidence.version,
      });
    await promoteHttpSubmission(client, input.gameId);
    return { ...evidence, event: { ...event.data, id: Number(event.id) } };
  });
}

export async function beginExclusiveSpriteOperation(input: {
  spriteName: string;
  gameId: string;
  kind: "score" | "restore" | "delete";
}) {
  return transaction(async (client) => {
    await lockSprite(client, input.spriteName);
    const { rowCount } = await client.query(
      `SELECT 1 FROM ctf.sprite_operations WHERE sprite_name=$1
       AND status IN ('running','unknown') LIMIT 1`,
      [input.spriteName],
    );
    if (rowCount) return null;
    const id = randomUUID();
    await client.query(
      `INSERT INTO ctf.sprite_operations(id,sprite_name,game_id,kind)
       VALUES($1,$2,$3,$4)`,
      [id, input.spriteName, input.gameId, input.kind],
    );
    return id;
  });
}

export async function completeExclusiveSpriteOperation(
  id: string,
  outcome: "completed" | "unknown",
) {
  await db.query(
    "UPDATE ctf.sprite_operations SET status=$2,completed_at=now() WHERE id=$1 AND status='running'",
    [id, outcome],
  );
}

export async function deleteSpriteIfEligible(spriteName: string) {
  const reservation = await transaction(async (client) => {
    await lockSprite(client, spriteName);
    const { rows: related } = await client.query<{ id: string; status: string }>(
      "SELECT id,status FROM ctf.games WHERE sprite_name=$1 ORDER BY id FOR UPDATE",
      [spriteName],
    );
    if (!related.length) return null;
    const {
      rows: [eligible],
    } = await client.query<{ okay: boolean }>(
      `SELECT bool_and(g.status IN ('captured','exhausted','ended')
         OR (g.status='caught' AND (SELECT count(*) FROM ctf.agent_sessions s WHERE s.game_id=g.id)>1)
         OR (g.status IN ('blocked','caught') AND
           (g.updated_at<now()-interval '25 hours' OR
             EXISTS(SELECT 1 FROM ctf.games c WHERE c.forked_from=g.id)))) AS okay
       FROM ctf.games g WHERE g.sprite_name=$1`,
      [spriteName],
    );
    if (!eligible.okay) return null;
    const {
      rows: [existing],
    } = await client.query<{ id: string; status: string; started_at: Date }>(
      `SELECT id,status,started_at FROM ctf.sprite_operations
       WHERE sprite_name=$1 AND kind='delete' AND status IN ('running','unknown')
       ORDER BY started_at DESC LIMIT 1 FOR UPDATE`,
      [spriteName],
    );
    if (existing) {
      if (existing.status === "running" && Date.now() - existing.started_at.getTime() < 120_000)
        return null;
      await client.query(
        "UPDATE ctf.sprite_operations SET status='running',started_at=now() WHERE id=$1",
        [existing.id],
      );
      return existing.id;
    }
    const id = randomUUID();
    await client.query(
      `INSERT INTO ctf.sprite_operations(id,sprite_name,game_id,kind)
       VALUES($1,$2,$3,'delete')`,
      [id, spriteName, related[0].id],
    );
    return id;
  });
  if (!reservation) return false;
  try {
    await destroyEnvironment(spriteName);
  } catch (error) {
    await db.query("UPDATE ctf.sprite_operations SET status='unknown' WHERE id=$1", [reservation]);
    throw error;
  }
  await transaction(async (client) => {
    await lockSprite(client, spriteName);
    await client.query(
      `UPDATE ctf.sprite_operations SET status='interrupted',completed_at=now()
       WHERE sprite_name=$1 AND id<>$2 AND status IN ('running','unknown')`,
      [spriteName, reservation],
    );
    await client.query(
      "UPDATE ctf.sprite_operations SET status='completed',completed_at=now() WHERE id=$1",
      [reservation],
    );
    await client.query(
      "UPDATE ctf.games SET sprite_deleted_at=now(),state_revision=state_revision+CASE WHEN monitor_mode='async' THEN 1 ELSE 0 END WHERE sprite_name=$1 AND sprite_deleted_at IS NULL",
      [spriteName],
    );
  });
  return true;
}
