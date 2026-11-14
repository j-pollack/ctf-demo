"use client";
import React, { useEffect, useRef } from "react";
import type { GameStatus, SessionSummary } from "@/lib/types";
import type { SessionUIMap } from "@/app/session-ui-state";
import { chipLabel, nextTabIndex, sessionIsRunning, sessionTurns } from "@/app/session-layout";

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
}: SessionChipsProps) {
  const chips = useRef<(HTMLButtonElement | null)[]>([]),
    strip = useRef<HTMLDivElement | null>(null);
  const focusedIndex = Math.max(
    0,
    sessions.findIndex((session) => session.id === focusedId),
  );
  // Keep the focused chip in view inside the scrolling strip, also when the strip narrows.
  useEffect(() => {
    const reveal = () =>
      chips.current[focusedIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
    reveal();
    if (!strip.current) return;
    const observer = new ResizeObserver(reveal);
    observer.observe(strip.current);
    return () => observer.disconnect();
  }, [focusedIndex, sessions.length]);
  return (
    <div className="run-sessions">
      <div className="chips" role="toolbar" aria-label="Sessions" ref={strip}>
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
              tabIndex={index === focusedIndex ? 0 : -1}
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
      </div>
      {onCreate && (
        <button
          type="button"
          className="session-add"
          aria-label={creating ? "Adding session" : "Add session"}
          onClick={onCreate}
          disabled={creating}
        >
          +<span className="add-label"> Add session</span>
        </button>
      )}
    </div>
  );
}
