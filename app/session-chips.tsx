"use client";
import React, { useEffect, useRef, useState } from "react";
import { sessionLimitRefusal, type GameStatus, type SessionSummary } from "@/lib/types";
import type { SessionUIMap } from "@/app/session-ui-state";
import {
  chipLabel,
  nextTabIndex,
  sessionIsRunning,
  PENDING_SESSION,
  sessionTurns,
  stripEdges,
} from "@/app/session-layout";

export type SessionChipsProps = {
  runStatus: GameStatus;
  sessions: SessionSummary[];
  sessionViews: SessionUIMap;
  shownIds: string[];
  focusedId: string | null;
  caughtSessionId: string | null;
  // Turn counts the player last saw, per session.
  seen: Record<string, number>;
  onActivate: (id: string) => void;
  onCreate?: () => void;
  creating: boolean;
  // Sessions a run may have. The server still decides; this only explains a disabled control.
  sessionLimit?: number;
  // The ordinal of a session being created, shown as a chip that cannot be activated yet.
  pendingOrdinal: number | null;
};

export function SessionChips({
  runStatus,
  sessions,
  sessionViews,
  shownIds,
  focusedId,
  caughtSessionId,
  seen,
  onActivate,
  onCreate,
  creating,
  sessionLimit,
  pendingOrdinal,
}: SessionChipsProps) {
  const chips = useRef<(HTMLButtonElement | null)[]>([]),
    strip = useRef<HTMLDivElement | null>(null);
  // A pending session's chip comes after every real one and can be the focused one.
  const pendingFocused = pendingOrdinal !== null && focusedId === PENDING_SESSION;
  const focusedIndex = pendingFocused
    ? sessions.length
    : Math.max(
        0,
        sessions.findIndex((session) => session.id === focusedId),
      );
  // The disabled pending chip cannot hold the tab stop, so the last real chip keeps it.
  const tabStop = Math.min(focusedIndex, sessions.length - 1);
  const [edges, setEdges] = useState({ start: false, end: false });
  const measureEdges = () => {
    if (!strip.current) return;
    const next = stripEdges(strip.current);
    setEdges((current) =>
      current.start === next.start && current.end === next.end ? current : next,
    );
  };
  // Chevrons duplicate what arrow keys already do, so they stay out of the tab order.
  const page = (direction: 1 | -1) =>
    strip.current?.scrollBy({
      left: direction * strip.current.clientWidth * 0.9,
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  // Keep the focused chip in view inside the scrolling strip, also when the strip narrows.
  useEffect(() => {
    const reveal = () => {
      chips.current[focusedIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
      measureEdges();
    };
    reveal();
    if (!strip.current) return;
    const observer = new ResizeObserver(reveal);
    observer.observe(strip.current);
    return () => observer.disconnect();
  }, [focusedIndex, sessions.length, pendingOrdinal]);
  const limitReason = sessionLimitRefusal(sessions.length, sessionLimit);
  return (
    <div className="run-sessions">
      <div className="chips-frame">
        <button
          type="button"
          className="chips-more"
          data-edge="start"
          aria-hidden="true"
          tabIndex={-1}
          hidden={!edges.start}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => page(-1)}
        >
          ‹
        </button>
        <div
          className="chips"
          role="toolbar"
          aria-label="Sessions"
          ref={strip}
          onScroll={measureEdges}
        >
          {sessions.map((session, index) => {
            const view = sessionViews[session.id],
              turns = sessionTurns(session.turns, view?.events ?? []),
              shown = shownIds.includes(session.id),
              running = sessionIsRunning(runStatus, view, session),
              caught = session.id === caughtSessionId,
              unseen = !shown && turns > (seen[session.id] ?? turns),
              focused = session.id === focusedId;
            return (
              <button
                key={session.id}
                ref={(element) => {
                  chips.current[index] = element;
                }}
                type="button"
                className="chip"
                data-shown={shown || undefined}
                data-caught={caught || undefined}
                data-unseen={unseen || undefined}
                aria-current={focused || undefined}
                aria-controls={shown ? `pane-${session.id}` : undefined}
                aria-label={chipLabel({
                  ordinal: session.ordinal,
                  turns,
                  running,
                  caught,
                  shown,
                  focused,
                  unseen,
                })}
                tabIndex={index === tabStop ? 0 : -1}
                onClick={() => onActivate(session.id)}
                onKeyDown={(event) => {
                  const next = nextTabIndex(event.key, index, sessions.length);
                  if (next === null) return;
                  event.preventDefault();
                  chips.current[next]?.focus();
                }}
              >
                {running && <i aria-hidden="true" />}
                {session.ordinal}
              </button>
            );
          })}
          {pendingOrdinal !== null && (
            <button
              ref={(element) => {
                chips.current[sessions.length] = element;
              }}
              type="button"
              className="chip"
              data-pending
              aria-current={pendingFocused || undefined}
              aria-label={`Session ${pendingOrdinal}, starting`}
              tabIndex={-1}
              disabled
            >
              {pendingOrdinal}
            </button>
          )}
        </div>
        <button
          type="button"
          className="chips-more"
          data-edge="end"
          aria-hidden="true"
          tabIndex={-1}
          hidden={!edges.end}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => page(1)}
        >
          ›
        </button>
      </div>
      {onCreate && (
        <button
          type="button"
          className="session-add"
          aria-label={creating ? "Adding session" : "Add session"}
          // At the limit the click still reaches the play UI, which shows the reason.
          onClick={creating ? undefined : onCreate}
          title={limitReason ?? undefined}
          // Not natively disabled while busy or at the limit, so keyboard focus stays on it.
          aria-disabled={creating || !!limitReason || undefined}
          aria-busy={creating || undefined}
        >
          +<span className="add-label"> Add session</span>
        </button>
      )}
    </div>
  );
}
