"use client";
import React from "react";
import type { GameStatus, PublicGame } from "@/lib/types";
import { Meter, MeterIndicator } from "@ui-sdk/react/meter";
import { money, MONITOR_STATUS_LOADING, monitorStatusLabel, statusLabel } from "@/app/run-format";
import { suspicionBand } from "@/app/transcript";

export type RunBarProps = {
  game: PublicGame;
  // Highest classifier risk across sessions, and whether any was recorded.
  peak: number;
  observed: boolean;
  // The session chips and Add session control.
  sessions?: React.ReactNode;
  inspectorOpen: boolean;
  detailsRef?: React.Ref<HTMLButtonElement>;
  newRunDisabled: boolean;
  newRunTitle?: string;
  onToggleDetails: () => void;
  // Opens run details at the classifier risk section.
  onShowRisk: () => void;
  onNewRun: () => void;
};

const outcomeBand: Partial<Record<GameStatus, string>> = {
  caught: "caught",
  blocked: "caught",
  captured: "low",
};

function runStatusText(game: PublicGame) {
  if (game.status === "captured") return "Captured";
  if (game.status !== "active") return statusLabel[game.status];
  if (game.monitorMode !== "async") return statusLabel.active;
  return game.monitor ? monitorStatusLabel[game.monitor.status] : MONITOR_STATUS_LOADING;
}

// A control, so a tap opens run details, where the score is explained. Hover text would not show
// on a phone.
function RunRisk({
  peak,
  observed,
  onShow,
}: {
  peak: number;
  observed: boolean;
  onShow: () => void;
}) {
  return (
    <button
      type="button"
      className="run-risk"
      data-band={observed ? suspicionBand(peak) : undefined}
      onClick={onShow}
    >
      {observed ? `Classifier risk ${Math.round(peak * 100)}%` : "No classifier risk yet"}
    </button>
  );
}

export function RunBar({
  game,
  peak,
  observed,
  sessions,
  inspectorOpen,
  detailsRef,
  newRunDisabled,
  newRunTitle,
  onToggleDetails,
  onShowRisk,
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
        {game.status === "active" && (
          <RunRisk peak={peak} observed={observed} onShow={onShowRisk} />
        )}
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
