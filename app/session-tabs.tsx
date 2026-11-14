"use client";

import React, { useEffect, useRef } from "react";
import type { GameStatus } from "@/lib/types";
import type { SessionUIMap } from "@/app/session-ui-state";

type Session = { id: string; ordinal: number; busy: boolean };

export function sessionIsRunning(
  status: GameStatus,
  view: { busy: boolean } | undefined,
  summary: { busy: boolean },
) {
  return status === "active" && (view?.busy ?? summary.busy);
}

export function nextTabIndex(key: string, current: number, length: number): number | null {
  if (length === 0) return null;
  if (key === "ArrowRight") return (current + 1) % length;
  if (key === "ArrowLeft") return (current - 1 + length) % length;
  if (key === "Home") return 0;
  if (key === "End") return length - 1;
  return null;
}

export function SessionTabs({
  runStatus,
  sessions,
  sessionViews,
  selectedId,
  panelId,
  onSelect,
  onCreate,
  creating,
}: {
  runStatus: GameStatus;
  sessions: Session[];
  sessionViews: SessionUIMap;
  selectedId: string | null;
  panelId: string;
  onSelect: (id: string) => void;
  onCreate?: () => void;
  creating: boolean;
}) {
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    const index = sessions.findIndex((session) => session.id === selectedId);
    if (index < 0) return;
    tabs.current[index]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedId, sessions.length]);
  return (
    <div className="session-strip">
      <div className="session-tabs" role="tablist" aria-label="Run sessions">
        {sessions.map((session, index) => {
          const selected = session.id === selectedId;
          const running = sessionIsRunning(runStatus, sessionViews[session.id], session);
          return (
            <button
              key={session.id}
              ref={(element) => {
                tabs.current[index] = element;
              }}
              type="button"
              role="tab"
              id={`session-tab-${session.id}`}
              aria-selected={selected}
              aria-controls={selected ? panelId : undefined}
              tabIndex={selected ? 0 : -1}
              className="session-tab"
              data-running={running || undefined}
              onClick={() => onSelect(session.id)}
              onKeyDown={(event) => {
                const next = nextTabIndex(event.key, index, sessions.length);
                if (next === null) return;
                event.preventDefault();
                tabs.current[next]?.focus();
                onSelect(sessions[next].id);
              }}
            >
              <span className="session-tab-label">Session {session.ordinal}</span>
              {running && (
                <span className="session-tab-status">
                  <i />
                  Running
                </span>
              )}
            </button>
          );
        })}
      </div>
      {onCreate && (
        <button type="button" className="session-new" onClick={onCreate} disabled={creating}>
          {creating ? "Creating…" : "+ New session"}
        </button>
      )}
    </div>
  );
}
