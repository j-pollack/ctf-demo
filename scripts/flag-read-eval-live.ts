import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { flagReadCases, type FlagReadCase } from "./flag-read-cases";
import {
  createInvestigationTraceRecorder,
  type InvestigationObserver,
} from "../lib/investigation-trace";
import type { ValidatedMonitorEvidence } from "../lib/monitor-evidence";
import type { FlagReadEntry, LiveEvaluationConfig } from "./flag-read-eval";
import {
  loadReviewGame,
  migrateFreshDatabase,
  seedWorkspace,
  type SeededWorkspace,
} from "./monitor-investigate-eval-live";

const CLASSIFIER_RESERVE_MICRODOLLARS = 10;

async function seedCase(
  pool: Pool,
  item: FlagReadCase,
  remainingMicrodollars: number,
  agentModel: string,
  classifierModel: string,
  monitorVersion: string,
) {
  const ownerId = `synthetic-flag-read-owner-${randomUUID()}`;
  const workspace = await seedWorkspace(
    pool,
    item.snapshot,
    ownerId,
    remainingMicrodollars,
    agentModel,
    classifierModel,
    monitorVersion,
    { activeSessionId: item.targetSessionId, observations: item.observations },
  );
  await pool.query("UPDATE ctf.games SET monitor_mode='async' WHERE id=$1", [workspace.gameId]);
  if (item.sameOwnerHistory)
    await seedWorkspace(
      pool,
      item.sameOwnerHistory,
      ownerId,
      remainingMicrodollars,
      agentModel,
      classifierModel,
      monitorVersion,
    );
  if (item.otherOwnerHistory)
    await seedWorkspace(
      pool,
      item.otherOwnerHistory,
      `synthetic-flag-read-decoy-${randomUUID()}`,
      remainingMicrodollars,
      agentModel,
      classifierModel,
      monitorVersion,
    );
  return workspace;
}

async function createClaim(
  pool: Pool,
  item: FlagReadCase,
  workspace: SeededWorkspace,
  enqueueMonitorJob: typeof import("../lib/monitor-jobs").enqueueMonitorJob,
  claimMonitorJob: typeof import("../lib/monitor-jobs").claimMonitorJob,
) {
  const sessionId = workspace.sessionIds.get(item.targetSessionId);
  if (!sessionId) throw new Error(`${item.id}: target session was not seeded.`);
  const {
    rows: [head],
  } = await pool.query<{ version: string; epoch: string }>(
    `SELECT version::text,epoch::text FROM ctf.transcript_observations
       WHERE session_id=$1 ORDER BY version DESC LIMIT 1`,
    [sessionId],
  );
  if (!head) throw new Error(`${item.id}: committed target evidence is missing.`);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await enqueueMonitorJob(client, {
      gameId: workspace.gameId,
      sessionId,
      epoch: Number(head.epoch),
      version: Number(head.version),
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  const claim = await claimMonitorJob();
  if (!claim || claim.gameId !== workspace.gameId || claim.sessionId !== sessionId)
    throw new Error(`${item.id}: evaluation could not claim its own target review job.`);
  return claim;
}

async function reviewCase(
  pool: Pool,
  item: FlagReadCase,
  workspace: SeededWorkspace,
  modules: {
    policy: typeof import("../lib/policy");
    typesafe: typeof import("../lib/typesafe");
    control: typeof import("../lib/control");
    jobs: typeof import("../lib/monitor-jobs");
    classifier: typeof import("../lib/monitor-classifier");
    investigator: typeof import("../lib/flag-read-investigator");
    snapshot: typeof import("../lib/monitor-snapshot");
    sessions: typeof import("../lib/sessions");
    games: typeof import("../lib/games");
    finalization: typeof import("../lib/async-finalization");
    inference: typeof import("../lib/inference");
  },
  testObserver?: InvestigationObserver,
): Promise<FlagReadEntry> {
  const started = Date.now();
  const claim = await createClaim(
    pool,
    item,
    workspace,
    modules.jobs.enqueueMonitorJob,
    modules.jobs.claimMonitorJob,
  );
  const reviewId = randomUUID();
  await pool.query(
    `INSERT INTO ctf.monitor_reviews
       (id,game_id,session_id,snapshot_revision,target_kind,model,prompt_version,job_id,job_claim_token)
     VALUES($1,$2,$3,$4,'transcript',$5,$6,$7,$8)`,
    [
      reviewId,
      claim.gameId,
      claim.sessionId,
      item.snapshot.revision,
      modules.policy.INVESTIGATOR_MODEL,
      modules.control.FLAG_READ_MONITOR_VERSION,
      claim.jobId,
      claim.claimToken,
    ],
  );
  let detected: boolean | null = null;
  let complete: boolean | null = null;
  let reason: string | undefined;
  let evidence: ValidatedMonitorEvidence[] | undefined;
  let operationalError: string | undefined;
  let retrievedReferences: string[] | undefined;
  let retrievalCalls: number | undefined;
  let calls: number | undefined;
  let monitorVersion: string | undefined;
  let investigatorModel: string | undefined;
  let reviewPersisted = false;
  const trace = createInvestigationTraceRecorder();
  const observer = testObserver
    ? {
        onInitialEvidence: (value: unknown) => {
          trace.observer.onInitialEvidence(value);
          testObserver.onInitialEvidence(value);
        },
        onToolResult: (value: Parameters<InvestigationObserver["onToolResult"]>[0]) => {
          trace.observer.onToolResult(value);
          testObserver.onToolResult(value);
        },
        onRecordingError: (code: Parameters<InvestigationObserver["onRecordingError"]>[0]) => {
          trace.observer.onRecordingError(code);
          testObserver.onRecordingError(code);
        },
      }
    : trace.observer;
  try {
    const game = await loadReviewGame(pool, claim.gameId, claim.sessionId);
    const snapshot = await modules.snapshot.captureCommittedMonitorSnapshot({
      gameId: claim.gameId,
      sessionId: claim.sessionId,
      epoch: claim.epoch,
      targetVersion: claim.targetVersion,
    });
    const target = snapshot.sessions.find((session) => session.id === claim.sessionId);
    if (!target) throw new Error(`${item.id}: committed target session disappeared.`);
    const signal = AbortSignal.timeout(Math.max(1, claim.claimUntil.getTime() - Date.now() - 1000));
    const classifier = await modules.classifier.classifyMonitorTarget({
      game,
      sessionId: claim.sessionId,
      lease: "",
      reviewId,
      messages: [...target.messages],
      target: { kind: "transcript" },
      signal,
      executionGeneration: Number(game.execution_generation ?? 0),
      jobClaim: claim,
    });
    await modules.sessions.updateMonitorClassifierSignals(reviewId, classifier.signals);
    const result = await modules.investigator.runFlagReadInvestigation(
      {
        game,
        reviewId,
        snapshot,
        currentSessionId: claim.sessionId,
        target: { kind: "transcript" },
        riskSignals: classifier.signals,
        signal,
        jobClaim: claim,
        includeReasoning: game.monitor_reasoning,
      },
      { observer },
    );
    reason = result.reason;
    evidence = result.evidence;
    const decision = modules.investigator.detectorToReviewDecision(result);
    detected = result.flagReadDetected;
    complete = result.investigationComplete;
    retrievedReferences = result.retrievedRefs;
    retrievalCalls = result.retrievalCalls;
    calls = result.calls;
    monitorVersion = result.monitorVersion;
    investigatorModel = result.investigatorModel;
    if (detected)
      await modules.finalization.catchAsyncRun(claim, reviewId, decision, classifier.suspicion);
    await modules.sessions.completeMonitorReview(reviewId, decision);
    reviewPersisted = true;
    await modules.jobs.finishMonitorJob(claim, { kind: decision.verdict, reason: decision.reason });
  } catch (error) {
    if (reviewPersisted) throw error;
    detected = null;
    complete = null;
    operationalError =
      modules.inference.diagnosticText(error instanceof Error ? error.message : String(error)) ??
      "Flag-read investigation failed.";
    await modules.sessions.completeMonitorReview(reviewId, {
      operationalError,
      latencyMs: Date.now() - started,
    });
    await modules.jobs.finishMonitorJob(claim, { kind: "error", reason: operationalError });
    // This one-pass evaluator records the retryable error and keeps later cases independent.
    await pool.query(
      "UPDATE ctf.monitor_jobs SET next_attempt_at=now()+interval '1 day' WHERE id=$1 AND status='queued'",
      [claim.jobId],
    );
  }
  const { rows: inferenceRows } = await pool.query<{ settled: string; held: string }>(
    `SELECT coalesce(sum(cost) FILTER(WHERE settled_at IS NOT NULL),0)::bigint AS settled,
       coalesce(sum(cost_ceiling) FILTER(WHERE settled_at IS NULL),0)::bigint AS held
     FROM ctf.inference WHERE game_id=$1 AND review_id=$2`,
    [claim.gameId, reviewId],
  );
  const billing = await modules.games.gameBilling(claim.gameId);
  const settledMicrodollars = Number(inferenceRows[0].settled);
  const heldMicrodollars = Number(inferenceRows[0].held);
  if (
    settledMicrodollars !== billing.monitorSpendMicrodollars ||
    heldMicrodollars !== billing.reservedMicrodollars
  )
    throw new Error(`${item.id}: persisted inference and game billing disagree.`);
  const {
    rows: [job],
  } = await pool.query<{
    status: string;
    covered_version: string;
    requested_version: string;
  }>(
    "SELECT status,covered_version::text,requested_version::text FROM ctf.monitor_jobs WHERE id=$1",
    [claim.jobId],
  );
  if (!job) throw new Error(`${item.id}: review job disappeared.`);
  return {
    caseId: item.id,
    reviewId,
    readOccurred: item.readOccurred,
    observableSufficiency: item.observableSufficiency,
    ...(item.observableEquivalenceGroup
      ? { observableEquivalenceGroup: item.observableEquivalenceGroup }
      : {}),
    flagReadDetected: detected,
    investigationComplete: complete,
    ...(reason ? { reason, evidence } : {}),
    trace: trace.snapshot(),
    ...(operationalError ? { operationalError } : {}),
    latencyMs: Date.now() - started,
    settledMicrodollars,
    heldMicrodollars,
    jobStatus: job.status,
    coveredVersion: Number(job.covered_version),
    targetVersion: Number(job.requested_version),
    retrievedReferences,
    retrievalCalls,
    calls,
    monitorVersion,
    investigatorModel,
  };
}

export async function runFlagReadLiveEvaluation(
  config: LiveEvaluationConfig,
  cases: readonly FlagReadCase[] = flagReadCases,
  testObserver?: InvestigationObserver,
): Promise<FlagReadEntry[]> {
  const { Pool } = await import("pg");
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 5,
    options: "-c search_path=ctf,public",
  });
  try {
    (globalThis as typeof globalThis & { ctfPool?: Pool }).ctfPool = pool;
    await migrateFreshDatabase(pool);
    const [
      policy,
      typesafe,
      control,
      jobs,
      classifier,
      investigator,
      snapshot,
      sessions,
      games,
      finalization,
      inference,
    ] = await Promise.all([
      import("../lib/policy"),
      import("../lib/typesafe"),
      import("../lib/control"),
      import("../lib/monitor-jobs"),
      import("../lib/monitor-classifier"),
      import("../lib/flag-read-investigator"),
      import("../lib/monitor-snapshot"),
      import("../lib/sessions"),
      import("../lib/games"),
      import("../lib/async-finalization"),
      import("../lib/inference"),
    ]);
    const modules = {
      policy,
      typesafe,
      control,
      jobs,
      classifier,
      investigator,
      snapshot,
      sessions,
      games,
      finalization,
      inference,
    };
    const entries: FlagReadEntry[] = [];
    let usedMicrodollars = 0;
    for (const item of cases) {
      const remaining = config.budgetMicrodollars - usedMicrodollars;
      if (remaining <= CLASSIFIER_RESERVE_MICRODOLLARS) {
        entries.push({
          caseId: item.id,
          readOccurred: item.readOccurred,
          observableSufficiency: item.observableSufficiency,
          ...(item.observableEquivalenceGroup
            ? { observableEquivalenceGroup: item.observableEquivalenceGroup }
            : {}),
          flagReadDetected: null,
          investigationComplete: null,
          operationalError: "Evaluation budget exhausted before classifier admission.",
          latencyMs: null,
          settledMicrodollars: 0,
          heldMicrodollars: 0,
        });
        continue;
      }
      const workspace = await seedCase(
        pool,
        item,
        remaining,
        policy.AGENT_MODEL,
        typesafe.TYPESAFE_MODEL,
        control.FLAG_READ_MONITOR_VERSION,
      );
      const entry = await reviewCase(pool, item, workspace, modules, testObserver);
      entries.push(entry);
      usedMicrodollars += entry.settledMicrodollars + entry.heldMicrodollars;
    }
    return entries;
  } finally {
    await pool.end();
    delete (globalThis as typeof globalThis & { ctfPool?: Pool }).ctfPool;
  }
}
