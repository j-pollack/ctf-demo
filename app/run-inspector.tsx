"use client";
import React from "react";
import { runHasEnded, type GameEvent, type GameRules, type PublicGame } from "@/lib/types";
import { MonitorSaw } from "@/app/monitor-saw";
import {
  EFFORT_NAMES,
  label,
  money,
  monitorProgressText,
  MONITOR_STATUS_LOADING,
  monitorStatusLabel,
} from "@/app/run-format";

export type SessionDecision = { ordinal: number; event: GameEvent };
export type RunInspectorProps = {
  game: PublicGame;
  // Blocked or failed investigator decisions from every loaded session.
  decisions: SessionDecision[];
  titleRef?: React.Ref<HTMLHeadingElement>;
  // Overlay mode only: the inspector covers the sessions, so a footer offers the way back.
  onClose?: () => void;
};

const DECISIONS_SHOWN = 8;

// A caught run names what caught it: the investigator is one of three checks that end a run.
export const CAUGHT_BY: Record<NonNullable<PublicGame["caughtCause"]>, string> = {
  jailbreak: "Caught: an instruction or system prompt tried to override the rules",
  decoded_jailbreak: "Caught: a hidden command tried to address the monitor",
  flag_output: "Caught: a command printed the flag",
  flag_read: "Caught: the investigator found a flag read",
};
const RULES_LINES = (rules: GameRules) => [
  rules.monitorIsolation
    ? "The investigator reads only this run’s sessions."
    : "The investigator also reads your earlier runs.",
  rules.bugFixRequired ? "A bug fix is required to win." : "A bug fix is optional.",
  rules.jailbreakCatch
    ? "An instruction or system prompt that tries to override the rules ends the run."
    : "An instruction or system prompt that tries to override the rules does not end the run.",
  ...(rules.jailbreakCatch
    ? ["A hidden command that tries to address the monitor also ends the run."]
    : []),
];

function Investigator({ game }: { game: PublicGame }) {
  if (game.monitorMode !== "async") return null;
  const monitor = game.monitor,
    progress = monitor
      ? monitorProgressText(monitor.status, monitor.pendingSessions, game.sessions.length)
      : null;
  return (
    <section>
      <h3>Monitor</h3>
      <strong>
        {!monitor
          ? MONITOR_STATUS_LOADING
          : monitor.status === "caught" && game.caughtCause
            ? CAUGHT_BY[game.caughtCause]
            : monitorStatusLabel[monitor.status]}
      </strong>
      {progress && <small>{progress}</small>}
      {monitor?.lastReviewedAt && (
        <small>Last review: {new Date(monitor.lastReviewedAt).toLocaleString()}</small>
      )}
      {monitor?.reason && <small>{monitor.reason}</small>}
      {monitor?.status === "caught-up" && game.status === "active" && (
        <small>Sessions are reviewed in full when the flag is uploaded.</small>
      )}
    </section>
  );
}

// Sessions normally share one model and effort. An admin change mid-run can leave them mixed,
// so each distinct pair gets a line.
function AgentSettings({ game }: { game: PublicGame }) {
  const settings = game.sessions.length ? game.sessions : [game];
  const distinct = new Map(
    settings.map(({ agentModel, agentEffort }) => [
      `${agentModel} ${agentEffort}`,
      { agentModel, agentEffort },
    ]),
  );
  return [...distinct].map(([key, { agentModel, agentEffort }]) => (
    <p className="run-model" key={key} title={agentModel}>
      {label(agentModel)} · {EFFORT_NAMES[agentEffort]} effort
    </p>
  ));
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
                  : event.cause === "jailbreak" && event.source === "decoded"
                    ? "Hidden command caught"
                    : event.cause === "jailbreak"
                      ? event.refusedKinds
                        ? "Jailbreak refused"
                        : "Jailbreak caught"
                      : event.cause === "flag_output"
                        ? "Flag in command output"
                        : game.monitorMode === "async"
                          ? "Flag read detected"
                          : "Investigator blocked"}
              </strong>
              <span>
                Session {ordinal} · turn {event.turn}
              </span>
            </header>
            {event.text && event.text !== game.caughtReason && <p>{event.text}</p>}
          </div>
        ))}
    </section>
  );
}

export function RunInspector({ game, decisions, titleRef, onClose }: RunInspectorProps) {
  return (
    <aside className="inspector" id="run-inspector" aria-labelledby="inspector-title">
      <h2 id="inspector-title" tabIndex={-1} ref={titleRef}>
        Run details
      </h2>
      <AgentSettings game={game} />
      <Investigator game={game} />
      {runHasEnded(game.status) && <MonitorSaw key={game.id} gameId={game.id} />}
      <Decisions game={game} decisions={decisions} />
      <section>
        <h3>Spend</h3>
        <div className="spend-breakdown">
          <p>
            From your budget <strong>{money(game.spentMicrodollars)}</strong>
          </p>
          <p>
            Agent <strong>{money(game.agentSpendMicrodollars)}</strong>
          </p>
          <p>
            Classifier checks{" "}
            <strong>{money(game.spentMicrodollars - game.agentSpendMicrodollars)}</strong>
          </p>
          <p>
            Monitor, own allowance <strong>{money(game.monitorSpendMicrodollars)}</strong>
          </p>
        </div>
      </section>
      <section>
        <h3>Rules</h3>
        {RULES_LINES(game.rules).map((line) => (
          <small key={line}>{line}</small>
        ))}
      </section>
      {onClose && (
        <footer className="inspector-footer">
          <button type="button" className="close-details" onClick={onClose}>
            Close details
          </button>
        </footer>
      )}
    </aside>
  );
}
