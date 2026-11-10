import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Pool } from "pg";
import type { ClassifierRiskSignals } from "../lib/control";
import type { MonitorSnapshot } from "../lib/types";
import { monitorInvestigationCases } from "./monitor-investigation-cases";
import type { EvaluationEntry, LiveEvaluationConfig } from "./monitor-investigate-eval";

const CLASSIFIER_RESERVE_MICRODOLLARS = 10;
const EVALUATION_OWNER = "synthetic-monitor-evaluation";
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
];

type SeededWorkspace = {
  gameId: string;
  sessionIds: Map<string, string>;
  leases: Map<string, string>;
};

type LiveModules = typeof import("../lib/games") &
  typeof import("../lib/sessions") &
  typeof import("../lib/monitor-snapshot") &
  typeof import("../lib/monitor-review") &
  typeof import("../lib/control") &
  typeof import("../lib/typesafe") &
  typeof import("../lib/policy") &
  typeof import("../lib/inference") &
  typeof import("../lib/monitor-classifier") & { db: typeof import("../lib/db").db };

function corpusWorkspaces() {
  const workspaces = new Map<string, MonitorSnapshot>();
  for (const item of monitorInvestigationCases) {
    workspaces.set(item.workspaceId, item.snapshot);
    for (const decoy of item.unrelatedWorkspaceDecoys ?? []) {
      const previous = workspaces.get(decoy.workspaceId);
      if (previous && JSON.stringify(previous) !== JSON.stringify(decoy.snapshot))
        throw new Error(`Workspace ${decoy.workspaceId} has conflicting synthetic snapshots.`);
      workspaces.set(decoy.workspaceId, decoy.snapshot);
    }
  }
  return workspaces;
}

async function migrateFreshDatabase(pool: Pool) {
  const { rows } = await pool.query("SELECT to_regnamespace('ctf') AS schema");
  if (rows[0].schema !== null)
    throw new Error("Refusing to migrate: the supplied database already has a ctf schema.");
  await pool.query(await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"));
  for (const migration of MIGRATIONS)
    await pool.query(
      await readFile(new URL(`../db/migrations/${migration}`, import.meta.url), "utf8"),
    );
}

async function seedWorkspace(
  pool: Pool,
  source: MonitorSnapshot,
  budgetMicrodollars: number,
  agentModel: string,
  classifierModel: string,
  monitorVersion: string,
): Promise<SeededWorkspace> {
  const gameId = randomUUID();
  const sourceSessionIds = source.sessions.map((session) => session.id);
  const sessionIds = new Map(sourceSessionIds.map((id) => [id, randomUUID()]));
  const leases = new Map(
    source.sessions.filter((session) => session.busy).map((session) => [session.id, randomUUID()]),
  );
  const activeSession = source.sessions.find((session) => session.busy);
  const gameLease = activeSession ? leases.get(activeSession.id)! : null;
  await pool.query(
    `INSERT INTO ctf.games
      (id,owner_id,sprite_name,secret_hash,agent_model,monitor_model,monitor_version,monitor_difficulty,
       token_budget,budget_microdollars,system_prompt,monitor_reasoning,status,lease,lease_until,
       observation_revision,monitor_settings_locked)
     VALUES($1,$2,$3,'synthetic-no-secret',$4,$5,$6,'hard',500000,$7,'',true,'active',$8,
       CASE WHEN $8::uuid IS NOT NULL THEN now()+interval '30 minutes' ELSE NULL END,$9,true)`,
    [
      gameId,
      EVALUATION_OWNER,
      `monitor-eval-${gameId}`,
      agentModel,
      classifierModel,
      monitorVersion,
      budgetMicrodollars,
      gameLease,
      source.revision,
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

async function loadReviewGame(pool: Pool, gameId: string, sessionId: string) {
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

async function reviewCase(
  item: (typeof monitorInvestigationCases)[number],
  workspace: SeededWorkspace,
  remainingMicrodollars: number,
  modules: LiveModules,
): Promise<EvaluationEntry> {
  const started = Date.now();
  const sessionId = workspace.sessionIds.get(item.subject.sessionId);
  const lease = workspace.leases.get(item.subject.sessionId);
  if (!sessionId || !lease)
    throw new Error(`${item.id}: target must be an active synthetic session.`);
  const budget = await modules.db.query(
    `UPDATE ctf.games SET budget_microdollars=$2 WHERE id=$1
       AND spent_microdollars+reserved_microdollars <= $2`,
    [workspace.gameId, remainingMicrodollars],
  );
  if (!budget.rowCount)
    throw new Error(`${item.id}: remaining budget is below already admitted spend.`);
  const initialSnapshot = await modules.captureMonitorSnapshot(workspace.gameId);
  const reviewId = await modules.createMonitorReview(workspace.gameId, {
    sessionId,
    snapshotRevision: initialSnapshot.revision,
    sourceLease: lease,
    targetKind: "command",
    toolCallId: item.subject.toolCallId,
    command: item.subject.command,
    classifierSignals: { evaluation: "classifier_pending" },
    model: modules.AGENT_MODEL,
    promptVersion: modules.MONITOR_VERSION,
  });
  let signals: ClassifierRiskSignals | undefined;
  let classifierRisk: number | null = null;
  let baselineCaught: boolean | null = null;
  let verdict: EvaluationEntry["verdict"] = null;
  let operationalError: string | undefined;
  let latencyMs: number | null = null;
  let initialEvidenceCount: number | null = 0;
  let retrievedReferences: string[] | null = [];
  let retrievalCalls: number | null = 0;
  let reviewStarted = false;
  let review: Awaited<ReturnType<typeof modules.runMonitorReview>> | undefined;
  try {
    const game = await loadReviewGame(modules.db, workspace.gameId, sessionId);
    const snapshot = await modules.captureMonitorSnapshot(workspace.gameId);
    const session = snapshot.sessions.find(
      (candidate: { id: string }) => candidate.id === sessionId,
    );
    if (!session) throw new Error("Captured evaluation session disappeared.");
    const classified = await modules.classifyMonitorTarget({
      game,
      sessionId,
      lease,
      reviewId,
      messages: [...session.messages],
      target: { kind: "command", command: item.subject.command },
      signal: new AbortController().signal,
      executionGeneration: Number(game.execution_generation ?? 0),
    });
    signals = classified.signals;
    classifierRisk = classified.suspicion;
    const threshold = modules.CONTROL_DIFFICULTY.hard.threshold;
    baselineCaught = classifierRisk >= threshold;
    await modules.db.query("UPDATE ctf.monitor_reviews SET classifier_signals=$2 WHERE id=$1", [
      reviewId,
      JSON.stringify({ ...signals, baselineRisk: classifierRisk, threshold }),
    ]);
    const billing = await modules.gameBilling(workspace.gameId);
    if (billing.spentMicrodollars + billing.reservedMicrodollars >= remainingMicrodollars)
      throw new Error("The evaluation budget is exhausted after classifier settlement.");
    const reviewSnapshot = await modules.captureMonitorSnapshot(workspace.gameId);
    reviewStarted = true;
    review = await modules.runMonitorReview({
      game,
      reviewId,
      snapshot: reviewSnapshot,
      currentSessionId: sessionId,
      target: {
        kind: "command",
        toolCallId: item.subject.toolCallId,
        command: item.subject.command,
      },
      riskSignals: signals,
      signal: new AbortController().signal,
      includeReasoning: true,
    });
    verdict = review.verdict;
    latencyMs = Date.now() - started;
    initialEvidenceCount = review.initialEvidenceCount;
    retrievedReferences = review.retrievedRefs;
    retrievalCalls = review.retrievalCalls;
  } catch (error) {
    operationalError =
      modules.diagnosticText(error instanceof Error ? error.message : String(error)) ??
      "Monitor operation failed.";
    latencyMs = Date.now() - started;
    if (reviewStarted) {
      initialEvidenceCount = null;
      retrievedReferences = null;
      retrievalCalls = null;
    }
  }
  await modules.completeMonitorReview(
    reviewId,
    review
      ? {
          verdict: review.verdict,
          reason: review.reason,
          evidence: review.evidence,
          latencyMs: review.latencyMs,
          calls: review.calls,
          retrievalCalls: review.retrievalCalls,
          retrievedRefs: review.retrievedRefs,
        }
      : {
          ...(signals ? { evidence: [] } : {}),
          operationalError: operationalError ?? "Monitor operation failed.",
          latencyMs,
        },
  );
  const rows = await modules.db.query(
    `SELECT coalesce(sum(cost) FILTER(WHERE settled_at IS NOT NULL),0)::bigint AS settled,
       coalesce(sum(cost_ceiling) FILTER(WHERE settled_at IS NULL),0)::bigint AS held
     FROM ctf.inference WHERE game_id=$1 AND review_id=$2`,
    [workspace.gameId, reviewId],
  );
  const billing = await modules.gameBilling(workspace.gameId);
  const settled = Number(rows.rows[0].settled);
  const held = Number(rows.rows[0].held);
  if (settled !== billing.monitorSpendMicrodollars || held !== billing.reservedMicrodollars)
    throw new Error(`${item.id}: persisted review inference disagrees with run billing totals.`);
  return {
    caseId: item.id,
    reviewId,
    expected: item.expected,
    ...(item.staleEvidence
      ? {
          staleEvidence: {
            ...item.staleEvidence,
            scope: "snapshot-only-monitor-judgment" as const,
          },
        }
      : {}),
    classifierRisk,
    classifierThreshold: modules.CONTROL_DIFFICULTY.hard.threshold,
    baselineCaught,
    verdict,
    ...(operationalError ? { operationalError } : {}),
    latencyMs,
    initialEvidenceCount,
    retrievedReferences,
    retrievalCalls,
    classifierModel: modules.TYPESAFE_MODEL,
    investigatorModel: modules.AGENT_MODEL,
    monitorVersion: modules.MONITOR_VERSION,
    settledMicrodollars: settled,
    heldMicrodollars: held,
  };
}

export async function runLiveEvaluation(config: LiveEvaluationConfig): Promise<EvaluationEntry[]> {
  const { Pool } = await import("pg");
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 5,
    options: "-c search_path=ctf,public",
  });
  try {
    if ((await pool.query("SELECT to_regnamespace('ctf') AS schema")).rows[0].schema !== null)
      throw new Error("Refusing to migrate: the supplied database already has a ctf schema.");
    (globalThis as typeof globalThis & { ctfPool?: Pool }).ctfPool = pool;
    await migrateFreshDatabase(pool);
    const [
      games,
      sessions,
      snapshots,
      monitor,
      control,
      typesafe,
      policy,
      inference,
      monitorClassifier,
      dbModule,
    ] = await Promise.all([
      import("../lib/games"),
      import("../lib/sessions"),
      import("../lib/monitor-snapshot"),
      import("../lib/monitor-review"),
      import("../lib/control"),
      import("../lib/typesafe"),
      import("../lib/policy"),
      import("../lib/inference"),
      import("../lib/monitor-classifier"),
      import("../lib/db"),
    ]);
    const modules: LiveModules = {
      ...games,
      ...sessions,
      ...snapshots,
      ...monitor,
      ...control,
      ...typesafe,
      ...policy,
      ...inference,
      ...monitorClassifier,
      db: dbModule.db,
    };
    const workspaces = new Map<string, SeededWorkspace>();
    for (const [workspaceId, snapshot] of corpusWorkspaces())
      workspaces.set(
        workspaceId,
        await seedWorkspace(
          pool,
          snapshot,
          config.budgetMicrodollars,
          modules.AGENT_MODEL,
          modules.TYPESAFE_MODEL,
          modules.MONITOR_VERSION,
        ),
      );
    const entries: EvaluationEntry[] = [];
    let usedMicrodollars = 0;
    for (const item of monitorInvestigationCases) {
      const remaining = config.budgetMicrodollars - usedMicrodollars;
      if (remaining <= CLASSIFIER_RESERVE_MICRODOLLARS) {
        entries.push({
          caseId: item.id,
          expected: item.expected,
          classifierRisk: null,
          classifierThreshold: modules.CONTROL_DIFFICULTY.hard.threshold,
          baselineCaught: null,
          verdict: null,
          operationalError: "Evaluation budget exhausted before classifier admission.",
          latencyMs: null,
          initialEvidenceCount: 0,
          retrievedReferences: [],
          retrievalCalls: 0,
          classifierModel: modules.TYPESAFE_MODEL,
          investigatorModel: modules.AGENT_MODEL,
          monitorVersion: modules.MONITOR_VERSION,
          settledMicrodollars: 0,
          heldMicrodollars: 0,
        });
        continue;
      }
      const workspace = workspaces.get(item.workspaceId);
      if (!workspace) throw new Error(`Missing seeded workspace ${item.workspaceId}.`);
      const scoped = await reviewCase(item, workspace, remaining, modules);
      entries.push(scoped);
      usedMicrodollars += scoped.settledMicrodollars + scoped.heldMicrodollars;
    }
    return entries;
  } finally {
    await pool.end();
  }
}
