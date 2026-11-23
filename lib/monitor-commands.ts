import { randomBytes, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Message } from "@earendil-works/pi-ai";
import type { PoolClient } from "pg";
import { db } from "./db";
import { transaction } from "./games";
import { enqueueMonitorJob, SETTLEABLE_COMMAND } from "./monitor-jobs";
import { GameError } from "./policy";
import { persistTranscriptEvidence } from "./transcript-evidence";
import { destroyEnvironment, listSessions } from "./sprites";
import { FLAG_OUTPUT_CATCH_TEXT, type GameEvent } from "./types";
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
       AND kind IN ('score','delete') AND status IN ('running','unknown') LIMIT 1`,
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

// Records when the command returned, which the investigator reads as evidence. One statement, no transaction and no lock beyond its own row.
export async function markCommandReturned(operationId: string) {
  await db.query(
    "UPDATE ctf.sprite_operations SET returned_at=clock_timestamp() WHERE id=$1 AND status='running' AND returned_at IS NULL",
    [operationId],
  );
}

type CommandResultInput = {
  dispatchId: string;
  gameId: string;
  sessionId: string;
  messages: Message[];
  outcome: "completed" | "interrupted" | "unknown";
  output: string;
};

// Stores a command's result on its operation, session and events, in the caller's transaction. The
// caller holds the run row.
async function storeCommandResult(client: PoolClient, input: CommandResultInput) {
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
  return { ...evidence, event: { ...event.data, id: Number(event.id) } };
}

export async function completeAsyncCommand(input: CommandResultInput) {
  return transaction(async (client) => {
    const {
      rows: [run],
    } = await client.query<{ observation_revision: string; monitor_mode: string }>(
      "SELECT observation_revision,monitor_mode FROM ctf.games WHERE id=$1 FOR UPDATE",
      [input.gameId],
    );
    if (!run || run.monitor_mode !== "async") throw new GameError("Run not found.", 404);
    const stored = await storeCommandResult(client, input);
    if (stored.changed)
      await enqueueMonitorJob(client, {
        gameId: input.gameId,
        sessionId: input.sessionId,
        epoch: stored.epoch,
        version: stored.version,
      });
    await promoteHttpSubmission(client, input.gameId);
    return stored;
  });
}

// Ends the run for a command whose output held the flag, in the transaction that stores the result.
// Queues no review and promotes no submission. Changes nothing unless the response still holds the
// run, so a catch that lost a race is `stale`. A lost lease does not matter: the generation change stops
// any later holder, as for every catch. A submission receipt does not make it stale.
export async function catchFlagOutput(
  input: Omit<CommandResultInput, "outcome"> & {
    toolCallId: string;
    generation: number;
  },
): Promise<{ status: "stale" } | { status: "caught"; events: GameEvent[] }> {
  return transaction(async (client) => {
    const {
      rows: [run],
    } = await client.query<{
      monitor_mode: string;
      status: string;
      execution_generation: string;
      turns: number;
    }>(
      "SELECT monitor_mode,status,execution_generation,turns FROM ctf.games WHERE id=$1 FOR UPDATE",
      [input.gameId],
    );
    if (!run || run.monitor_mode !== "async") throw new GameError("Run not found.", 404);
    if (run.status !== "active" || Number(run.execution_generation) !== input.generation)
      return { status: "stale" as const };
    await client.query(
      `UPDATE ctf.games SET status='caught',blocks=blocks+1,
       execution_generation=execution_generation+1,state_revision=state_revision+1,updated_at=now()
       WHERE id=$1`,
      [input.gameId],
    );
    const stored = await storeCommandResult(client, { ...input, outcome: "completed" });
    const data: Omit<GameEvent, "id"> = {
      kind: "monitor",
      text: FLAG_OUTPUT_CATCH_TEXT,
      decision: "block",
      cause: "flag_output",
      toolCallId: input.toolCallId,
      turn: run.turns,
    };
    const {
      rows: [monitor],
    } = await client.query<{ id: string }>(
      "INSERT INTO ctf.events(game_id,session_id,data) VALUES($1,$2,$3) RETURNING id",
      [input.gameId, input.sessionId, JSON.stringify(data)],
    );
    return {
      status: "caught" as const,
      events: [stored.event, { ...data, id: Number(monitor.id) }],
    };
  });
}

export async function beginExclusiveSpriteOperation(input: {
  spriteName: string;
  gameId: string;
  kind: "score" | "delete";
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
      `SELECT bool_and(g.status IN ('captured','exhausted','ended','blocked','caught')) AS okay
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

// How long a sprite whose last check failed or showed a session is left alone.
const SETTLE_BACKOFF_MS = 10_000;
// ponytail: per-process memory, shared by the loops of one worker process. A restart only costs
// one early re-check; move it to the database if several worker processes hammer one sprite.
const recentlyChecked = new Map<string, number>();

// A command the runner could not see finish is `unknown`. Once its sprite holds no exec session,
// the command is dead: the abort killed its process group and `timeout` bounds any other. The ids
// are recorded before the list call, so a command that turns unknown during it waits for a later pass.
// Every candidate sprite is checked at once, so one slow or failing sprite blocks no other.
export async function settleStoppedCommands(
  onFailure: (spriteName: string, error: unknown) => void,
  now = Date.now(),
) {
  for (const [name, at] of recentlyChecked)
    if (now - at >= SETTLE_BACKOFF_MS) recentlyChecked.delete(name);
  const { rows: sprites } = await db.query<{ sprite_name: string; ids: string[] }>(
    `SELECT o.sprite_name,array_agg(o.id) AS ids FROM ctf.sprite_operations o
     WHERE ${SETTLEABLE_COMMAND} GROUP BY o.sprite_name`,
  );
  await Promise.all(
    sprites
      .filter(({ sprite_name }) => !recentlyChecked.has(sprite_name))
      .map(async ({ sprite_name, ids }) => {
        try {
          if (!(await listSessions(sprite_name)).length) {
            await settleOperations(sprite_name, ids);
            return;
          }
        } catch (error) {
          onFailure(sprite_name, error);
        }
        recentlyChecked.set(sprite_name, now);
      }),
  );
}

// The lock order of deleteSpriteIfEligible: sprite, then runs by id, then operations.
async function settleOperations(spriteName: string, ids: string[]) {
  await transaction(async (client) => {
    await lockSprite(client, spriteName);
    await client.query(
      `SELECT id FROM ctf.games WHERE id IN
         (SELECT game_id FROM ctf.sprite_operations WHERE id=ANY($1::uuid[]))
       ORDER BY id FOR UPDATE`,
      [ids],
    );
    const { rows: settled } = await client.query<{ game_id: string }>(
      `UPDATE ctf.sprite_operations SET status='interrupted',completed_at=now()
       WHERE id=ANY($1::uuid[]) AND status='unknown' RETURNING game_id`,
      [ids],
    );
    if (!settled.length) return;
    const gameIds = [...new Set(settled.map(({ game_id }) => game_id))].sort();
    await client.query(
      "UPDATE ctf.games SET state_revision=state_revision+1 WHERE id=ANY($1::uuid[])",
      [gameIds],
    );
    for (const gameId of gameIds) await promoteHttpSubmission(client, gameId);
  });
}
