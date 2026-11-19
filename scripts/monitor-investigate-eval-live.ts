import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Message } from "@earendil-works/pi-ai";
import type { Pool } from "pg";
import type { MonitorFixtureSnapshot } from "./monitor-investigation-cases";

const EVALUATION_SYSTEM_PROMPT = "Synthetic evaluation-only system prompt.";
const MIGRATIONS = [
  "002-dollar-seasons.sql",
  "003-monitor-reasoning.sql",
  "005-estimated-settlement.sql",
  "006-system-prompt.sql",
  "007-inference-game-index.sql",
  "008-block-ends-run.sql",
  "009-monitor-choice.sql",
  "010-control-monitor.sql",
  "011-agent-effort.sql",
  "012-new-run.sql",
  "013-agent-sessions.sql",
  "014-async-monitor.sql",
  "015-transcript-evidence.sql",
  "018-monitor-ready.sql",
  "019-session-stop.sql",
  "020-http-flag-submission.sql",
  "021-game-rules.sql",
  "022-tool-call-annotations.sql",
  "023-text-screens.sql",
  "024-command-returned.sql",
];

export type SeededWorkspace = {
  gameId: string;
  sessionIds: Map<string, string>;
  leases: Map<string, string>;
};

export async function migrateFreshDatabase(pool: Pool) {
  const { rows } = await pool.query("SELECT to_regnamespace('ctf') AS schema");
  if (rows[0].schema !== null)
    throw new Error("Refusing to migrate: the supplied database already has a ctf schema.");
  await pool.query(await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"));
  for (const migration of MIGRATIONS)
    await pool.query(
      await readFile(new URL(`../db/migrations/${migration}`, import.meta.url), "utf8"),
    );
  const { backfillTranscriptSearchText } = await import("../lib/transcript-evidence");
  await backfillTranscriptSearchText(pool);
}

export async function seedWorkspace(
  pool: Pool,
  source: MonitorFixtureSnapshot,
  ownerId: string,
  budgetMicrodollars: number,
  agentModel: string,
  classifierModel: string,
  monitorVersion: string,
  options: {
    activeSessionId?: string;
    observations?: Record<string, readonly Message[][]>;
    observationTimes?: Record<string, readonly string[]>;
  } = {},
): Promise<SeededWorkspace> {
  const gameId = randomUUID();
  const sourceSessionIds = source.sessions.map((session) => session.id);
  const sessionIds = new Map(sourceSessionIds.map((id) => [id, randomUUID()]));
  const leases = new Map(
    source.sessions
      .filter((session) => session.busy || session.id === options.activeSessionId)
      .map((session) => [session.id, randomUUID()]),
  );
  const activeSession = source.sessions.find(
    (session) => session.busy || session.id === options.activeSessionId,
  );
  const gameLease = activeSession ? leases.get(activeSession.id)! : null;
  await pool.query(
    `INSERT INTO ctf.games
      (id,owner_id,sprite_name,secret_hash,agent_model,monitor_model,monitor_version,monitor_difficulty,
       token_budget,budget_microdollars,system_prompt,monitor_reasoning,status,lease,lease_until,
       observation_revision,monitor_settings_locked)
     VALUES($1,$2,$3,'synthetic-no-secret',$4,$5,$6,'hard',500000,$7,'',true,$10,$8,
       CASE WHEN $8::uuid IS NOT NULL THEN now()+interval '30 minutes' ELSE NULL END,$9,true)`,
    [
      gameId,
      ownerId,
      `monitor-eval-${gameId}`,
      agentModel,
      classifierModel,
      monitorVersion,
      budgetMicrodollars,
      gameLease,
      source.revision,
      activeSession ? "active" : "ended",
    ],
  );
  for (const session of source.sessions) {
    const lease = leases.get(session.id) ?? null;
    await pool.query(
      `INSERT INTO ctf.agent_sessions
        (id,game_id,ordinal,agent_model,agent_effort,system_prompt,messages,turns,lease,lease_until)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,
         CASE WHEN $9::uuid IS NOT NULL THEN now()+interval '30 minutes' ELSE NULL END)`,
      [
        sessionIds.get(session.id),
        gameId,
        session.ordinal,
        session.agentModel,
        session.agentEffort,
        EVALUATION_SYSTEM_PROMPT,
        JSON.stringify(session.messages),
        session.turns,
        lease,
      ],
    );
  }
  const { persistTranscriptEvidence } = await import("../lib/transcript-evidence");
  const evidenceClient = await pool.connect();
  try {
    await evidenceClient.query("BEGIN");
    for (const session of source.sessions) {
      for (const [index, messages] of (
        options.observations?.[session.id] ?? [session.messages]
      ).entries()) {
        const sessionId = sessionIds.get(session.id)!;
        await persistTranscriptEvidence(evidenceClient, {
          gameId,
          sessionId,
          runRevision: source.revision,
          messages,
        });
        const observedAt = options.observationTimes?.[session.id]?.[index];
        if (observedAt)
          await evidenceClient.query(
            "UPDATE ctf.transcript_observations SET observed_at=$2 WHERE session_id=$1 AND version=$3",
            [sessionId, observedAt, index + 1],
          );
      }
    }
    await evidenceClient.query("COMMIT");
  } catch (error) {
    await evidenceClient.query("ROLLBACK");
    throw error;
  } finally {
    evidenceClient.release();
  }
  for (const command of source.commands.filter(
    (item) => item.admittedRevision !== null || item.outcome !== null,
  )) {
    await pool.query(
      `INSERT INTO ctf.monitor_reviews
        (id,game_id,session_id,snapshot_revision,target_kind,tool_call_id,command,classifier_signals,
         model,prompt_version,verdict,reason,evidence,admitted_revision,completed_revision,outcome,
         created_at,completed_at)
       VALUES($1,$2,$3,$4,'command',$5,$6,'{}',$7,$8,'allow','Synthetic historical fixture',
         '[]',$9,$10,$11,now(),CASE WHEN $10::bigint IS NOT NULL OR $11::text IS NOT NULL THEN now() ELSE NULL END)`,
      [
        randomUUID(),
        gameId,
        sessionIds.get(command.sessionId),
        Math.max(0, (command.admittedRevision ?? 1) - 1),
        command.toolCallId,
        command.command,
        agentModel,
        monitorVersion,
        command.admittedRevision,
        command.completedRevision,
        command.outcome,
      ],
    );
  }
  return { gameId, sessionIds, leases };
}

export async function loadReviewGame(pool: Pool, gameId: string, sessionId: string) {
  const { rows } = await pool.query(
    `SELECT g.*,s.id AS session_id,s.agent_model,s.agent_effort,s.system_prompt,s.messages,s.turns,
       s.lease,s.lease_until FROM ctf.games g JOIN ctf.agent_sessions s ON s.game_id=g.id
     WHERE g.id=$1 AND s.id=$2`,
    [gameId, sessionId],
  );
  if (!rows[0]?.lease || !rows[0]?.lease_until)
    throw new Error("Evaluation target session has no live synthetic lease.");
  return rows[0];
}
