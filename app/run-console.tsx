"use client";
import React, { useEffect, useRef } from "react";
import type { GameEvent, PublicGame, SessionSummary } from "@/lib/types";
import { runHasStarted, type SessionUIMap } from "@/app/session-ui-state";
import { PENDING_SESSION, type InspectorMode } from "@/app/session-layout";
import { hasRiskObservations, runPeakRisk, runRiskSeries } from "@/app/run-risk";
import { money } from "@/app/run-format";
import { BlockedNotice, endBanner } from "@/app/transcript";
import { RunBar } from "@/app/run-bar";
import { RunInspector, type SessionDecision } from "@/app/run-inspector";
import { SessionChips } from "@/app/session-chips";
import { PendingPane, SessionPane } from "@/app/session-pane";
import { useShortcut } from "@ui-sdk/react/shortcuts";

// Run-level state the outcome strip reports besides the run's own status.
export type ConsoleOutcome = {
  detailError: string;
  detailLoading: boolean;
  // A run-level action in progress, such as starting a run.
  stage: string;
  // An active run opened from My Runs can be continued here.
  canContinue: boolean;
  continueDisabled: boolean;
};

export type PaneHandlers = {
  onDraftChange: (id: string, value: string) => void;
  onSystemDraftChange: (id: string, value: string) => void;
  onSend: (id: string) => void;
  onStop: (id: string) => void;
  onRetry: (id: string) => void;
  onDismissError: (id: string) => void;
  onCopy: (event: GameEvent) => void;
};

export type RunConsoleProps = {
  game: PublicGame;
  // Every session of the run, in ordinal order.
  sessions: SessionSummary[];
  sessionViews: SessionUIMap;
  focusedId: string | null;
  shownIds: string[];
  inspector: InspectorMode;
  workbenchRef: React.Ref<HTMLDivElement>;
  seen: Record<string, number>;
  // The player can send instructions in this view.
  editable: boolean;
  // A run-level action is in progress.
  busy: boolean;
  // Sessions with a local stream that Stop can abort.
  streamingIds: string[];
  creatingSession: boolean;
  // The ordinal a session being created will get; its placeholder id is in `shownIds`.
  pendingOrdinal: number | null;
  newRunDisabled: boolean;
  newRunTitle?: string;
  outcome: ConsoleOutcome;
  pane: PaneHandlers;
  onCreateSession?: () => void;
  onFocusSession: (id: string) => void;
  onToggleDetails: () => void;
  onCloseInspector: () => void;
  onNewRun: () => void;
  onContinue: () => void;
  onRetryDetail: () => void;
};

const FINALIZING_COPY = {
  unresolved: "Play has ended. Review could not be completed, so the result remains unconfirmed.",
  pending: "Play has ended. The result is pending investigator review.",
  legacy: "Submission is under investigator review…",
};

function OutcomeStrip({
  game,
  events,
  outcome,
  onShowCaught,
  onContinue,
  onRetryDetail,
  newRun,
}: {
  game: PublicGame;
  // Events from every loaded session.
  events: GameEvent[];
  outcome: ConsoleOutcome;
  onShowCaught?: () => void;
  onContinue: () => void;
  onRetryDetail: () => void;
  // Narrow screens have no New run in the run bar, so a finished run offers it here.
  newRun: { onClick: () => void; disabled: boolean; title?: string };
}) {
  const caught = game.status === "blocked" || game.status === "caught",
    finalizing = game.status === "finalizing",
    ended = !caught && !finalizing && game.status !== "active";
  if (
    !caught &&
    !ended &&
    !finalizing &&
    !outcome.detailError &&
    !outcome.detailLoading &&
    !outcome.stage &&
    !outcome.canContinue
  )
    return null;
  const banner = ended
    ? endBanner(
        game.status,
        events.findLast((event) => event.kind === "submit"),
      )
    : null;
  return (
    <section className="outcome" aria-label="Run outcome">
      {(caught || ended) && (
        <button
          type="button"
          className="new-run outcome-new-run"
          onClick={newRun.onClick}
          disabled={newRun.disabled}
          title={newRun.title}
        >
          New run
        </button>
      )}
      {outcome.detailError && (
        <div role="alert" className="error">
          {outcome.detailError}
          <button type="button" className="link" onClick={onRetryDetail}>
            Retry
          </button>
        </div>
      )}
      {outcome.detailLoading && <p role="status">Loading run…</p>}
      {caught && (
        <BlockedNotice
          status={game.status}
          caughtSessionId={game.caughtSessionId}
          caughtSessionOrdinal={game.caughtSessionOrdinal}
          caughtReason={game.caughtReason}
          blockedCommand={events.some(
            (event) => event.kind === "monitor" && event.decision === "block" && !!event.command,
          )}
          onShowSession={onShowCaught}
        />
      )}
      {banner && (
        <div className={banner.className}>
          <h2>{banner.heading}</h2>
          <p>
            {banner.win
              ? `The agent fixed a bug and got the flag through the investigator review. ${money(game.spentMicrodollars)} spent over ${game.turns} turns.`
              : banner.detail}
          </p>
        </div>
      )}
      {finalizing && (
        <div role="status" className="stage">
          {game.monitorMode !== "async"
            ? FINALIZING_COPY.legacy
            : game.monitor?.status === "unresolved"
              ? FINALIZING_COPY.unresolved
              : FINALIZING_COPY.pending}
        </div>
      )}
      {outcome.stage && (
        <div role="status" className="stage">
          <i aria-hidden="true" />
          {outcome.stage}…
        </div>
      )}
      {outcome.canContinue && (
        <button className="primary" disabled={outcome.continueDisabled} onClick={onContinue}>
          Continue run
        </button>
      )}
    </section>
  );
}

// Overlay mode moves focus into the inspector and back to Details when it closes.
function useInspectorFocus(inspector: InspectorMode, onClose: () => void) {
  const detailsRef = useRef<HTMLButtonElement | null>(null),
    titleRef = useRef<HTMLHeadingElement | null>(null),
    previous = useRef(inspector);
  useEffect(() => {
    const was = previous.current;
    previous.current = inspector;
    if (inspector === "overlay" && was !== "overlay") titleRef.current?.focus();
    // Focus left with the closed overlay goes back to Details; focus on a chip stays put.
    else if (
      was === "overlay" &&
      inspector === "closed" &&
      (!document.activeElement || document.activeElement === document.body)
    )
      detailsRef.current?.focus();
  }, [inspector]);
  // An open ui-sdk modal dialog pauses page shortcuts, so it owns Escape.
  useShortcut(inspector === "overlay" ? "escape" : null, onClose, { allowInInput: true });
  return { detailsRef, titleRef };
}

export function RunConsole(props: RunConsoleProps) {
  const { game, sessions, sessionViews, shownIds, focusedId, inspector, pane } = props;
  const { detailsRef, titleRef } = useInspectorFocus(inspector, props.onCloseInspector);
  const riskSeries = runRiskSeries(sessions, sessionViews),
    peak = runPeakRisk(riskSeries),
    observed = hasRiskObservations(riskSeries);
  const events = sessions.flatMap((session) => sessionViews[session.id]?.events ?? []);
  const decisions: SessionDecision[] = sessions.flatMap((session) =>
    (sessionViews[session.id]?.events ?? [])
      .filter(
        (event) =>
          event.kind === "monitor" && (event.decision === "block" || event.decision === "error"),
      )
      .map((event) => ({ ordinal: session.ordinal, event })),
  );
  const caughtId = game.caughtSessionId,
    // For the intro only: a first instruction in flight already counts as a start.
    started =
      runHasStarted(game, sessionViews) ||
      sessions.some((session) => {
        const view = sessionViews[session.id];
        return !!view && (view.busy || view.events.length > 0);
      });
  return (
    <div className="console">
      <RunBar
        game={game}
        peak={peak}
        observed={observed}
        inspectorOpen={inspector !== "closed"}
        detailsRef={detailsRef}
        newRunDisabled={props.newRunDisabled}
        newRunTitle={props.newRunTitle}
        onToggleDetails={props.onToggleDetails}
        onNewRun={props.onNewRun}
        sessions={
          <SessionChips
            runStatus={game.status}
            sessions={sessions}
            sessionViews={sessionViews}
            shownIds={shownIds}
            focusedId={focusedId}
            caughtSessionId={caughtId}
            seen={props.seen}
            onActivate={(id) => {
              // A chip switches the panes under an overlay, so the overlay closes to show them.
              if (inspector === "overlay") props.onCloseInspector();
              props.onFocusSession(id);
            }}
            onCreate={props.onCreateSession}
            creating={props.creatingSession}
            pendingOrdinal={props.pendingOrdinal}
          />
        }
      />
      <OutcomeStrip
        game={game}
        events={events}
        outcome={props.outcome}
        onShowCaught={
          caughtId && sessions.some((session) => session.id === caughtId)
            ? () => props.onFocusSession(caughtId)
            : undefined
        }
        onContinue={props.onContinue}
        onRetryDetail={props.onRetryDetail}
        newRun={{
          onClick: props.onNewRun,
          disabled: props.newRunDisabled,
          title: props.newRunTitle,
        }}
      />
      <div
        className="workbench"
        ref={props.workbenchRef}
        data-inspector={inspector === "closed" ? undefined : inspector}
      >
        <div
          className="deck"
          style={{ "--panes": shownIds.length } as React.CSSProperties}
          inert={inspector === "overlay"}
        >
          {shownIds.map((id) => {
            if (id === PENDING_SESSION && props.pendingOrdinal !== null)
              return (
                <PendingPane
                  key={id}
                  id={id}
                  ordinal={props.pendingOrdinal}
                  focused={focusedId === id}
                />
              );
            const session = sessions.find((item) => item.id === id);
            if (!session) return null;
            return (
              <SessionPane
                key={`${game.id}:${id}`}
                session={session}
                view={sessionViews[id]}
                runStatus={game.status}
                editable={props.editable}
                focused={id === focusedId}
                runStarted={started}
                disabled={props.busy}
                streaming={props.streamingIds.includes(id)}
                onFocus={() => props.onFocusSession(id)}
                onDraftChange={(value) => pane.onDraftChange(id, value)}
                onSystemDraftChange={(value) => pane.onSystemDraftChange(id, value)}
                onSend={() => pane.onSend(id)}
                onStop={() => pane.onStop(id)}
                onRetry={() => pane.onRetry(id)}
                onDismissError={() => pane.onDismissError(id)}
                onCopy={pane.onCopy}
              />
            );
          })}
        </div>
        {inspector !== "closed" && (
          <RunInspector
            game={game}
            riskSeries={riskSeries}
            peak={peak}
            observed={observed}
            decisions={decisions}
            titleRef={titleRef}
            footer={
              inspector === "overlay"
                ? {
                    onClose: props.onCloseInspector,
                    onNewRun: props.onNewRun,
                    newRunDisabled: props.newRunDisabled,
                    newRunTitle: props.newRunTitle,
                  }
                : undefined
            }
          />
        )}
      </div>
    </div>
  );
}
