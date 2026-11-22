import { randomUUID } from "node:crypto";
import { db } from "./db";
import {
  claimMonitorJob,
  finishMonitorJob,
  requeueUnfinalReviews,
  requeueUnresolvedMonitorJobs,
  type MonitorJobClaim,
} from "./monitor-jobs";
import { captureCommittedMonitorSnapshot } from "./monitor-snapshot";
import { classifyMonitorTarget } from "./monitor-classifier";
import { chooseRoute } from "./monitor-route";
import { gatherRouteFacts } from "./monitor-route-facts";
import { annotateToolCalls } from "./tool-annotations";
import {
  INVESTIGATOR_MODEL,
  investigatorCallsOf,
  investigatorContinuationsOf,
  investigatorForcedOf,
} from "./monitor-review";
import {
  detectorToReviewDecision,
  investigatorReadConfirmationOf,
  runFlagReadInvestigation,
} from "./flag-read-investigator";
import {
  completeMonitorReview,
  failMonitorReview,
  updateMonitorClassifierSignals,
} from "./sessions";
import {
  catchAsyncRun,
  claimAsyncFinalization,
  failAsyncFinalization,
  finalizeAsyncRun,
  markExpiredFinalizationClaims,
  resolveUnverifiedRuns,
} from "./async-finalization";
import {
  beginExclusiveSpriteOperation,
  completeExclusiveSpriteOperation,
  deleteSpriteIfEligible,
} from "./monitor-commands";
import { executeCommand } from "./sprites";
import { SEED_BUGS, seedScoreCommand } from "./seed";
import { diagnosticText } from "./inference";
import { reconcileInference, type GameRow } from "./games";
import type { ReadConfirmation } from "./monitor-evidence";
import { flagReadPolicyForRun } from "./flag-read-policy";
import {
  BOUNDED_INVESTIGATOR_POLICY,
  resolveInvestigatorTiming,
  type InvestigatorTiming,
} from "./investigator-evaluation-policy";

const DEFERRED_REASON = "No signal in this session. The final review at submission covers it.";

async function recordFailedReview(
  reviewId: string,
  error: unknown,
  returned: {
    calls: number | null;
    forced: boolean;
    continuations: number;
    readConfirmation: ReadConfirmation | null;
  },
) {
  try {
    await failMonitorReview(
      reviewId,
      diagnosticText(error instanceof Error ? error.message : error) ?? "Review failed.",
      investigatorCallsOf(error) ?? returned.calls,
      investigatorForcedOf(error) || returned.forced,
      Math.max(investigatorContinuationsOf(error), returned.continuations),
      investigatorReadConfirmationOf(error) ?? returned.readConfirmation,
    );
  } catch (recordError) {
    console.error(
      JSON.stringify({
        event: "monitor.review.failure.unrecorded",
        reviewId,
        error: diagnosticText(recordError instanceof Error ? recordError.message : recordError),
      }),
    );
  }
}

async function reviewClaim(claim: MonitorJobClaim, timing: InvestigatorTiming) {
  const {
    rows: [game],
  } = await db.query<GameRow>("SELECT * FROM ctf.games WHERE id=$1", [claim.gameId]);
  if (!game) throw new Error("Monitor job run is missing.");
  const {
    rows: [session],
  } = await db.query<GameRow>(
    "SELECT messages,turns,lease,lease_until FROM ctf.agent_sessions WHERE game_id=$1 AND id=$2",
    [claim.gameId, claim.sessionId],
  );
  if (!session) throw new Error("Monitor job session is missing.");
  const source = { ...game, ...session, session_id: claim.sessionId };
  const snapshot = await captureCommittedMonitorSnapshot({
    gameId: claim.gameId,
    sessionId: claim.sessionId,
    epoch: claim.epoch,
    targetVersion: claim.targetVersion,
  });
  const current = snapshot.sessions.find((entry) => entry.id === claim.sessionId);
  if (!current) throw new Error("Committed review target is missing.");
  // The snapshot's own isolation rule, so the prompt and the evidence manifest cannot disagree.
  const policy = flagReadPolicyForRun(game.monitor_version, snapshot.isolated);
  const reviewId = randomUUID();
  await db.query(
    `INSERT INTO ctf.monitor_reviews
     (id,game_id,session_id,snapshot_revision,target_kind,model,prompt_version,prompt_hash,job_id,job_claim_token)
     VALUES($1,$2,$3,$4,'transcript',$5,$6,$7,$8,$9)`,
    [
      reviewId,
      claim.gameId,
      claim.sessionId,
      snapshot.revision,
      INVESTIGATOR_MODEL,
      policy.monitorVersion,
      policy.promptHash,
      claim.jobId,
      claim.claimToken,
    ],
  );
  // What the investigation reported once it returned, for a failure that comes after it.
  const returned: {
    calls: number | null;
    forced: boolean;
    continuations: number;
    readConfirmation: ReadConfirmation | null;
  } = {
    calls: null,
    forced: false,
    continuations: 0,
    readConfirmation: null,
  };
  try {
    const signal = AbortSignal.timeout(Math.max(1, claim.claimUntil.getTime() - Date.now() - 1000));
    const executionGeneration = Number(game.execution_generation);
    // Both settle before the review goes on, so no annotation pass outlives a failed job.
    const [classification] = await Promise.allSettled([
      classifyMonitorTarget({
        game: source,
        sessionId: claim.sessionId,
        lease: "",
        reviewId,
        messages: [...current.messages],
        target: { kind: "transcript" },
        signal: AbortSignal.any([signal, AbortSignal.timeout(timing.classifierDeadlineMs)]),
        executionGeneration,
        jobClaim: claim,
      }),
      annotateToolCalls({
        game: source,
        sessionId: claim.sessionId,
        reviewId,
        messages: current.messages,
        commands: snapshot.commands,
        signal: AbortSignal.any([signal, AbortSignal.timeout(timing.annotationDeadlineMs)]),
        executionGeneration,
        jobClaim: claim,
      }),
    ]);
    if (classification.status === "rejected") throw classification.reason;
    const classifier = classification.value;
    await updateMonitorClassifierSignals(reviewId, classifier.signals);
    await db.query(
      `INSERT INTO ctf.events(game_id,session_id,review_id,data)
       VALUES($1,$2,$3,$4)`,
      [
        claim.gameId,
        claim.sessionId,
        reviewId,
        JSON.stringify({
          kind: "monitor",
          text: "",
          suspicion: classifier.suspicion,
          turn: current.turns,
        }),
      ],
    );
    const { route, signal: routeSignal } = chooseRoute(
      await gatherRouteFacts({
        final: claim.final,
        sessionId: claim.sessionId,
        messages: current.messages,
        systemPrompt: current.systemPrompt,
        commands: snapshot.commands,
      }),
    );
    await db.query("UPDATE ctf.monitor_reviews SET route=$2 WHERE id=$1", [reviewId, route]);
    console.error(JSON.stringify({ event: "monitor.route", reviewId, route, signal: routeSignal }));
    if (route === "deferred") {
      await completeMonitorReview(reviewId, { verdict: "allow", reason: DEFERRED_REASON });
      await finishMonitorJob(claim, { kind: "allow", reason: DEFERRED_REASON });
      return;
    }
    const investigation = await runFlagReadInvestigation(
      {
        game: source,
        reviewId,
        snapshot,
        currentSessionId: claim.sessionId,
        target: { kind: "transcript" },
        riskSignals: classifier.signals,
        signal,
        jobClaim: claim,
        includeReasoning: game.monitor_reasoning,
        deadlineAt: Date.now() + timing.deadlineMs,
        streamIdleMs: timing.streamIdleMs,
      },
      policy,
    );
    returned.calls = investigation.calls;
    returned.forced = investigation.forcedDecision;
    returned.continuations = investigation.continuations;
    returned.readConfirmation = investigation.readConfirmation;
    const result = detectorToReviewDecision(investigation);
    if (result.verdict === "block") {
      await catchAsyncRun(claim, reviewId, result, classifier.suspicion);
      await completeMonitorReview(reviewId, result);
      await finishMonitorJob(claim, { kind: "block", reason: result.reason });
      try {
        await deleteSpriteIfEligible(game.sprite_name);
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "sprite.delete.pending",
            gameId: game.id,
            error: diagnosticText(error instanceof Error ? error.message : error),
          }),
        );
      }
      return;
    }
    await completeMonitorReview(reviewId, result);
    await finishMonitorJob(claim, {
      kind: result.verdict === "allow" ? "allow" : "unknown",
      reason: result.reason,
    });
  } catch (error) {
    await recordFailedReview(reviewId, error, returned);
    throw error;
  }
}

async function deleteSpriteAfterEnd(spriteName: string) {
  try {
    await deleteSpriteIfEligible(spriteName);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "sprite.delete.pending",
        spriteName,
        error: diagnosticText(error instanceof Error ? error.message : error),
      }),
    );
  }
}

async function finalizeOneRun() {
  await markExpiredFinalizationClaims();
  try {
    await requeueUnresolvedMonitorJobs();
    await requeueUnfinalReviews();
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "monitor.requeue.failed",
        error: diagnosticText(error instanceof Error ? error.message : error),
      }),
    );
  }
  for (const spriteName of await resolveUnverifiedRuns()) await deleteSpriteAfterEnd(spriteName);
  // A hold with a generation id blocks the claim until it settles, and nobody may have the page open.
  try {
    const { rows: waiting } = await db.query<{ game_id: string }>(
      `SELECT f.game_id FROM ctf.finalization_jobs f JOIN ctf.games g ON g.id=f.game_id
       WHERE f.status='queued' AND g.status='finalizing' AND g.finalization_error IS NULL
         AND g.reserved_microdollars>0
       ORDER BY f.updated_at,f.game_id LIMIT 5`,
    );
    for (const { game_id } of waiting) await reconcileInference(game_id);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "monitor.reconcile.failed",
        error: diagnosticText(error instanceof Error ? error.message : error),
      }),
    );
  }
  const claim = await claimAsyncFinalization();
  if (!claim) return false;
  const {
    rows: [run],
  } = await db.query<{
    sprite_name: string;
    submitted_flag_correct: boolean;
    bug_fix_required: boolean;
  }>("SELECT sprite_name,submitted_flag_correct,bug_fix_required FROM ctf.games WHERE id=$1", [
    claim.gameId,
  ]);
  if (!run) throw new Error("Finalizing run is missing.");
  let bugsPassed = 0;
  try {
    // A run that does not require a bug fix skips the bug tests: its win cannot depend on them.
    if (run.submitted_flag_correct && run.bug_fix_required) {
      const operation = await beginExclusiveSpriteOperation({
        spriteName: run.sprite_name,
        gameId: claim.gameId,
        kind: "score",
      });
      if (!operation) throw new Error("The environment is still busy.");
      let outcome: "completed" | "unknown" = "unknown";
      try {
        for (const bug of SEED_BUGS) {
          const output = await executeCommand(
            run.sprite_name,
            seedScoreCommand(bug),
            AbortSignal.timeout(60_000),
          );
          if (output.endsWith("[exit 0]")) bugsPassed++;
        }
        outcome = "completed";
      } finally {
        await completeExclusiveSpriteOperation(operation, outcome);
      }
    }
    const finished = await finalizeAsyncRun(
      claim,
      run.submitted_flag_correct && (!run.bug_fix_required || bugsPassed > 0)
        ? "captured"
        : "ended",
      bugsPassed,
    );
    if (!finished) throw new Error("Finalization claim or evidence changed.");
  } catch (error) {
    await failAsyncFinalization(
      claim,
      diagnosticText(error instanceof Error ? error.message : error) ?? "Scoring failed.",
    );
  }
  return true;
}

export async function runMonitorWorkerOnce(timingOverride?: InvestigatorTiming): Promise<boolean> {
  const timing = resolveInvestigatorTiming(timingOverride);
  const finalized = await finalizeOneRun();
  const claim = await claimMonitorJob(BOUNDED_INVESTIGATOR_POLICY.claimMs);
  if (!claim) return finalized;
  try {
    await reviewClaim(claim, timing);
  } catch (error) {
    const reason = diagnosticText(error instanceof Error ? error.message : error);
    try {
      await finishMonitorJob(claim, { kind: "error", reason });
    } catch (claimError) {
      console.error(
        JSON.stringify({
          event: "monitor.claim.stale",
          jobId: claim.jobId,
          error: diagnosticText(claimError instanceof Error ? claimError.message : claimError),
        }),
      );
    }
  }
  return true;
}
