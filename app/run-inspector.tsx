"use client";
import React from "react";
import type { GameEvent, PublicGame } from "@/lib/types";
import type { SessionRiskSeries } from "@/app/run-risk";
import { RunRiskChart } from "@/app/run-risk-chart";
import { money, monitorProgressText, monitorStatusLabel } from "@/app/run-format";
import { suspicionBand } from "@/app/transcript";

export type SessionDecision = { ordinal: number; event: GameEvent };

export type RunInspectorProps = {
  game: PublicGame;
  riskSeries: SessionRiskSeries[];
  peak: number;
  observed: boolean;
  // Blocked or failed investigator decisions from every loaded session.
  decisions: SessionDecision[];
  titleRef?: React.Ref<HTMLHeadingElement>;
};

const DECISIONS_SHOWN = 8;

function Investigator({ game }: { game: PublicGame }) {
  if (game.monitorMode !== "async") return null;
  const monitor = game.monitor,
    progress = monitor
      ? monitorProgressText(monitor.status, monitor.pendingSessions, game.sessions.length)
      : null;
  return (
    <section>
      <h3>Investigator</h3>
      <strong>{monitor ? monitorStatusLabel[monitor.status] : "Waiting for status"}</strong>
      {progress && <small>{progress}</small>}
      {monitor?.lastReviewedAt && (
        <small>Last review: {new Date(monitor.lastReviewedAt).toLocaleString()}</small>
      )}
      {monitor?.reason && <small>{monitor.reason}</small>}
    </section>
  );
}

function Decisions({ game, decisions }: { game: PublicGame; decisions: SessionDecision[] }) {
  if (!decisions.length) return null;
  return (
    <section>
      <h3>Decisions</h3>
      {decisions
        .toSorted((left, right) => right.event.id - left.event.id)
        .slice(0, DECISIONS_SHOWN)
        .map(({ ordinal, event }) => (
          <div className="receipt" key={`${ordinal}:${event.id}`}>
            <header>
              <strong className={event.decision}>
                {event.decision === "error"
                  ? "Investigation error"
                  : game.monitorMode === "async"
                    ? "Flag read detected"
                    : "Investigator blocked"}
              </strong>
              <span>
                Session {ordinal} ·{" "}
                {typeof event.suspicion === "number"
                  ? `${Math.round(event.suspicion * 100)}% classifier risk`
                  : `turn ${event.turn}`}
              </span>
            </header>
            {event.text && <p>{event.text}</p>}
          </div>
        ))}
    </section>
  );
}

export function RunInspector({
  game,
  riskSeries,
  peak,
  observed,
  decisions,
  titleRef,
}: RunInspectorProps) {
  return (
    <aside className="inspector" id="run-inspector" aria-labelledby="inspector-title">
      <h2 id="inspector-title" tabIndex={-1} ref={titleRef}>
        Run details
      </h2>
      <Investigator game={game} />
      <section>
        <div className="risk-heading">
          <h3>Classifier risk, advisory</h3>
          <strong
            data-band={observed ? suspicionBand(peak) : undefined}
            title={
              observed
                ? `Highest classifier risk score across all sessions: ${peak.toFixed(2)} out of 1`
                : "No classifier risk observations have been recorded yet"
            }
          >
            {observed ? `Peak ${Math.round(peak * 100)}%` : "No risk data yet"}
          </strong>
        </div>
        <RunRiskChart series={riskSeries} />
      </section>
      <Decisions game={game} decisions={decisions} />
      <section>
        <h3>Spend</h3>
        <div className="spend-breakdown">
          <p>
            Spent <strong>{money(game.spentMicrodollars)}</strong>
          </p>
          <p>
            Agent <strong>{money(game.agentSpendMicrodollars)}</strong>
          </p>
          <p>
            Monitor <strong>{money(game.monitorSpendMicrodollars)}</strong>
          </p>
        </div>
      </section>
    </aside>
  );
}
