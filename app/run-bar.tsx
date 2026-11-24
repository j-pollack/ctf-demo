"use client";
import React from "react";
import type { GameStatus, PublicGame } from "@/lib/types";
import { Meter, MeterIndicator } from "@ui-sdk/react/meter";
import { money, MONITOR_STATUS_LOADING, monitorStatusLabel, statusLabel } from "@/app/run-format";

export type RunBarProps = {
  game: PublicGame;
  // The session chips and Add session control.
  sessions?: React.ReactNode;
  inspectorOpen: boolean;
  detailsRef?: React.Ref<HTMLButtonElement>;
  newRunDisabled: boolean;
  newRunTitle?: string;
  onToggleDetails: () => void;
  onNewRun: () => void;
};

const outcomeBand: Partial<Record<GameStatus, string>> = {
  caught: "caught",
  blocked: "caught",
  captured: "low",
};

function runStatusText(game: PublicGame) {
  if (game.status !== "active") return statusLabel[game.status];
  if (game.monitorMode !== "async") return statusLabel.active;
  return game.monitor ? monitorStatusLabel[game.monitor.status] : MONITOR_STATUS_LOADING;
}

export function RunBar({
  game,
  sessions,
  inspectorOpen,
  detailsRef,
  newRunDisabled,
  newRunTitle,
  onToggleDetails,
  onNewRun,
}: RunBarProps) {
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
            <small className="run-pending">{money(game.reservedMicrodollars)} pending</small>
          )}
        </span>
        <span
          className="run-status"
          role="status"
          data-band={outcomeBand[game.status]}
          // An active run's investigator status also lives in the inspector; narrow bars drop it.
          data-active={game.status === "active" || undefined}
        >
          {runStatusText(game)}
        </span>
      </div>
      {sessions}
      <div className="run-actions">
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
        >
          New run
        </button>
      </div>
    </section>
  );
}
