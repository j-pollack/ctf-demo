import type { Message } from "@earendil-works/pi-ai";
import {
  bindQueuedTranscriptReview,
  createMonitorReview,
  completeMonitorReview,
  updateMonitorClassifierSignals,
} from "./sessions";
import { captureMonitorSnapshot } from "./monitor-snapshot";
import { classifyMonitorTarget, type ClassifierTarget } from "./monitor-classifier";
import { runMonitorReview, INVESTIGATOR_MODEL, type MonitorTarget } from "./monitor-review";
import type { GameRow } from "./games";
import { MONITOR_VERSION } from "./control";
import { diagnosticText } from "./inference";

export async function investigateTarget(input: {
  game: GameRow;
  sessionId: string;
  lease: string;
  target: MonitorTarget;
  signal: AbortSignal;
  deadlineAt?: number;
  finalizationToken?: string;
  pendingReviewId?: string;
  queuedReviewId?: string;
}) {
  const started = Date.now();
  const deadlineAt = Math.min(
    started + 60_000,
    input.deadlineAt ?? Number.POSITIVE_INFINITY,
    new Date(input.game.lease_until ?? 0).getTime() - 5000,
  );
  const deadline = AbortSignal.timeout(Math.max(0, deadlineAt - Date.now()));
  const reviewSignal = AbortSignal.any([input.signal, deadline]);
  let reviewId = input.queuedReviewId;
  try {
    const snapshot = await captureMonitorSnapshot(input.game.id);
    const session = snapshot.sessions.find((candidate) => candidate.id === input.sessionId);
    if (!session) throw new Error("The review session is missing from its workspace snapshot.");
    reviewId ??= await createMonitorReview(input.game.id, {
      sessionId: input.sessionId,
      sourceLease: input.lease,
      finalizationToken: input.finalizationToken,
      snapshotRevision: snapshot.revision,
      targetKind: input.target.kind,
      ...(input.target.kind === "command" && {
        toolCallId: input.target.toolCallId,
        command: input.target.command,
      }),
      model: INVESTIGATOR_MODEL,
      promptVersion: MONITOR_VERSION,
    });
    if (input.queuedReviewId)
      await bindQueuedTranscriptReview(
        input.game.id,
        input.sessionId,
        input.lease,
        reviewId,
        Number(input.game.execution_generation ?? 0),
        snapshot.revision,
      );
    const classifier = await classifyMonitorTarget({
      game: input.game,
      sessionId: input.sessionId,
      lease: input.lease,
      reviewId,
      messages: [...session.messages] as Message[],
      target: input.target as ClassifierTarget,
      signal: reviewSignal,
      executionGeneration: Number(input.game.execution_generation ?? 0),
      finalizationToken: input.finalizationToken,
      pendingReviewId: input.pendingReviewId ?? reviewId,
    });
    await updateMonitorClassifierSignals(reviewId, classifier.signals);
    const result = await runMonitorReview({
      game: input.game,
      reviewId,
      snapshot,
      currentSessionId: input.sessionId,
      target: input.target,
      riskSignals: classifier.signals,
      signal: reviewSignal,
      deadlineAt,
      finalizationToken: input.finalizationToken,
      pendingReviewId: input.pendingReviewId ?? reviewId,
      includeReasoning: input.game.monitor_reasoning,
    });
    return { snapshot, reviewId, classifier, result };
  } catch (error) {
    if (reviewId) {
      try {
        await completeMonitorReview(reviewId, {
          operationalError:
            error instanceof Error ? diagnosticText(error.message) : "Unknown monitor failure.",
          latencyMs: Date.now() - started,
        });
      } catch (persistenceError) {
        console.error(
          JSON.stringify({
            event: "monitor.review.error_persistence_failed",
            timestamp: new Date().toISOString(),
            gameId: input.game.id,
            reviewId,
            error: diagnosticText(
              persistenceError instanceof Error ? persistenceError.message : persistenceError,
            ),
          }),
        );
        throw new AggregateError(
          [error, persistenceError],
          "Monitor failure could not be persisted.",
        );
      }
    }
    throw error;
  }
}

export async function completeInvestigation(
  reviewId: string,
  investigation: Awaited<ReturnType<typeof investigateTarget>>["result"],
) {
  await completeMonitorReview(reviewId, investigation);
}
