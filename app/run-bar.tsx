"use client";
import React from "react";
import type { GameStatus, PublicGame } from "@/lib/types";
import { Meter, MeterIndicator } from "@ui-sdk/react/meter";
import { ReportProblem } from "@/app/report-problem";
import { money, MONITOR_STATUS_LOADING, monitorStatusLabel, statusLabel } from "@/app/run-format";

export type RunBarProps = {
  game: PublicGame;
  // The session chips and Add session control.
  sessions?: React.ReactNode;
  // The session the player is looking at, named in a report.
  focusedSessionId?: string | null;
  inspectorOpen: boolean;
  detailsRef?: React.Ref<HTMLButtonElement>;
  newRunDisabled: boolean;
  newRunTitle?: string;
  onToggleDetails: () => void;
  onNewRun: () => void;
};

export const outcomeBand: Partial<Record<GameStatus, string>> = {
  caught: "caught",
  blocked: "caught",
  captured: "low",
};

function runStatusText(game: PublicGame) {
  if (game.status !== "active") return statusLabel[game.status];
  if (game.monitorMode !== "async") return statusLabel.active;
  return game.monitor
    ? monitorStatusLabel(game.monitor.status, game.sessions)
    : MONITOR_STATUS_LOADING;
}

export function RunBar({
  game,
  sessions,
  focusedSessionId = null,
  inspectorOpen,
  detailsRef,
  newRunDisabled,
  newRunTitle,
  onToggleDetails,
  onNewRun,
}: RunBarProps) {
  const active = game.status === "active";
  const allowance = game.budgetMicrodollars,
    left = Math.max(0, allowance - game.spentMicrodollars - game.reservedMicrodollars);
  return (
    <section className="run-bar" aria-label="Run">
      <div className="run-stats">
        <span className="run-id">
          Run <strong>{game.id.slice(0, 8).toUpperCase()}</strong>
        </span>
        <span className="run-budget">
          <strong>{money(left)} left</strong>
          <Meter
            render={<span />}
            className="run-meter"
            value={left}
            min={0}
            max={allowance}
            aria-label="Budget left"
            getValueLabel={() => `${money(left)} left of ${money(allowance)}`}
          >
            <MeterIndicator render={<span />} />
          </Meter>
          <span className="run-total">of {money(allowance)}</span>
          {!!game.reservedMicrodollars && (
            <small
              className="run-pending"
              title="Set aside for model calls that have not finished."
            >
              {money(game.reservedMicrodollars)} held
            </small>
          )}
        </span>
        {active && <span className="run-status">{runStatusText(game)}</span>}
        {/* An active run's label changes with every review, so it sits outside this region. The
            region stays in the page, empty, so the outcome is announced when it arrives. */}
        <span
          className={active ? undefined : "run-status"}
          role="status"
          data-band={outcomeBand[game.status]}
          data-testid="run-status"
          data-state={game.status}
        >
          {active ? null : runStatusText(game)}
        </span>
      </div>
      {sessions}
      <div className="run-actions">
        <ReportProblem gameId={game.id} focusedId={focusedSessionId} />
        <button
          type="button"
          className="details"
          ref={detailsRef}
          aria-expanded={inspectorOpen}
          aria-controls={inspectorOpen ? "run-inspector" : undefined}
          onClick={onToggleDetails}
        >
          Details
        </button>
        <button
          type="button"
          className="new-run"
          onClick={onNewRun}
          disabled={newRunDisabled}
          title={newRunTitle}
          data-testid="run-new"
        >
          New run
        </button>
      </div>
    </section>
  );
}
