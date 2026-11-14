"use client";
import React, { useEffect, useState } from "react";
import type { GameEvent, GameStatus, PublicGame, SessionSummary } from "@/lib/types";
import type { SessionUIState } from "@/app/session-ui-state";
import { Entry, groupTurns, liveCall } from "@/app/transcript";
import { EFFORT_NAMES, label } from "@/app/run-format";
import { sessionIsRunning, sessionTurns } from "@/app/session-layout";
import {
  createScrollAreaController,
  ScrollArea,
  ScrollAreaContent,
  ScrollAreaViewport,
} from "@ui-sdk/react/scroll-area";

// Mirrors the server, which stores a whitespace-only prompt as "".
export function systemPromptChange(draft: string, baseValue: string) {
  const next = draft.trim() ? draft : "";
  return next === baseValue ? {} : { systemPrompt: next };
}

export function SystemPrompt({
  id,
  game,
  editable,
  systemDraft,
  changeSystemDraft,
  onPromptToggle,
}: {
  id?: string;
  game: Pick<PublicGame, "systemPrompt"> | null;
  editable: boolean;
  systemDraft: string;
  changeSystemDraft: (value: string) => void;
  onPromptToggle: () => void;
}) {
  const changed =
    editable && "systemPrompt" in systemPromptChange(systemDraft, game?.systemPrompt ?? "");
  if (!editable && !game?.systemPrompt) return null;
  return (
    <details className="system-prompt" onToggle={onPromptToggle}>
      <summary>
        System prompt
        {changed && (
          <span className="unsaved">
            <span className="visually-hidden">Sends with next instruction</span>
          </span>
        )}
      </summary>
      <span className="hidden-tag">Hidden from investigator</span>
      {editable ? (
        <textarea
          id={id}
          aria-label="System prompt, hidden from the investigator"
          value={systemDraft}
          onChange={(event) => changeSystemDraft(event.target.value)}
          maxLength={8192}
          rows={4}
          placeholder="Optional. Your secret plan for the agent: it reads this every turn, and the investigator never sees it."
        />
      ) : (
        <p tabIndex={0}>{game?.systemPrompt}</p>
      )}
    </details>
  );
}

export type SessionPaneProps = {
  session: SessionSummary;
  view: SessionUIState | undefined;
  runStatus: GameStatus;
  // The player can send instructions and edit the system prompt.
  editable: boolean;
  focused: boolean;
  // A run-level action (starting or continuing a run) is in progress.
  disabled: boolean;
  // This session has a local stream that Stop can abort.
  streaming: boolean;
  onFocus: () => void;
  onDraftChange: (value: string) => void;
  onSystemDraftChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  onRetry: () => void;
  onDismissError: () => void;
  onCopy: (event: GameEvent) => void;
};

// Follows new output while the reader is at the end; sending always jumps there.
function useScrollFollow(view: SessionUIState | undefined) {
  const [controller] = useState(createScrollAreaController);
  useEffect(() => {
    if (view?.unconfirmed) controller.scrollToEnd({ behavior: "instant" });
  }, [view?.unconfirmed]);
  return controller;
}

function LiveEntry({ live }: { live: NonNullable<SessionUIState["live"]> }) {
  return (
    <article className="entry agent live" aria-live="polite" aria-busy="true">
      <header>
        <strong className="speaker">AGENT</strong>
        <span className="turn-label">STREAMING</span>
      </header>
      {live.reasoning && (
        <details open>
          <summary>Agent reasoning</summary>
          <p>{live.reasoning}</p>
        </details>
      )}
      {live.text && <p>{live.text}</p>}
      {live.calls.map((call, index) => (
        <div className="call" key={index}>
          <pre>{liveCall(call)}</pre>
        </div>
      ))}
    </article>
  );
}

function ThreadBody({
  session,
  view,
  disabled,
  onRetry,
  onDismissError,
  onCopy,
}: Pick<
  SessionPaneProps,
  "session" | "view" | "disabled" | "onRetry" | "onDismissError" | "onCopy"
>) {
  const fetched = !!view?.fetched;
  const error = view?.error ? (
    <div role="alert" className="error">
      {view.error}
      {fetched ? (
        <button type="button" className="link" aria-label="Dismiss error" onClick={onDismissError}>
          ×
        </button>
      ) : (
        <button type="button" className="link" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  ) : null;
  if (!view || !fetched)
    return (
      error ?? (
        <p role="status" className="stage">
          <i aria-hidden="true" />
          Loading session {session.ordinal}…
        </p>
      )
    );
  return (
    <>
      {view.events.length === 0 && (
        <div className="empty mission-intro">
          <span className="eyebrow">YOUR MOVE</span>
          <h2>Find a bug. Fix it. Submit the flag.</h2>
          <p>
            Send your agent into <code>/workspace</code>. Have it read <code>TASKS.md</code>, then
            choose a bug to solve. The investigator watches its work.
          </p>
        </div>
      )}
      {groupTurns(view.events).map(({ event, calls, pending }, index, groups) => (
        <Entry
          key={event.id}
          event={event}
          previous={groups[index - 1]?.event}
          calls={calls}
          pending={pending}
          disabled={disabled || view.busy}
          onCopy={() => onCopy(event)}
        />
      ))}
      {!view.busy && view.unconfirmed && (
        <p role="status" className="stage">
          Checking whether your instruction went through. Wait before sending it again.
        </p>
      )}
      {view.live && <LiveEntry live={view.live} />}
      {view.stage && (
        <div role="status" className="stage">
          <i aria-hidden="true" />
          {view.stage}…
        </div>
      )}
      {error}
    </>
  );
}

function Composer({
  session,
  view,
  disabled,
  streaming,
  onDraftChange,
  onSend,
  onStop,
}: Pick<
  SessionPaneProps,
  "session" | "view" | "disabled" | "streaming" | "onDraftChange" | "onSend" | "onStop"
>) {
  const draft = view?.draft ?? "",
    loading = disabled || !view?.fetched || !!view?.busy || !!view?.unconfirmed,
    id = `prompt-${session.id}`;
  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        onSend();
      }}
    >
      <label htmlFor={id} className="visually-hidden">
        Instruction for session {session.ordinal}
      </label>
      <textarea
        id={id}
        value={draft}
        onChange={(event) => onDraftChange(event.target.value)}
        maxLength={8192}
        rows={2}
        placeholder="Tell the agent what to do next. The investigator can review this."
        disabled={loading}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            onSend();
          }
        }}
      />
      {view?.busy && streaming ? (
        <button type="button" onClick={onStop}>
          Stop
        </button>
      ) : (
        <button className="primary" disabled={loading || !draft.trim()}>
          Send
        </button>
      )}
      <small className="send-hint">⌘/Ctrl + Enter to send</small>
    </form>
  );
}

export function SessionPane(props: SessionPaneProps) {
  const { session, view, runStatus, editable, focused, onFocus } = props;
  const controller = useScrollFollow(view);
  const turns = sessionTurns(session.turns, view?.events ?? []);
  const running = sessionIsRunning(runStatus, view, session);
  const title = `pane-title-${session.id}`;
  return (
    <section
      className="pane"
      id={`pane-${session.id}`}
      aria-labelledby={title}
      data-focused={focused || undefined}
      onFocus={onFocus}
      onPointerDown={onFocus}
    >
      <header className="pane-head">
        <h2 id={title}>Session {session.ordinal}</h2>
        <span className="pane-turns">
          {turns} {turns === 1 ? "turn" : "turns"}
        </span>
        {running && (
          <span className="pane-running">
            <i aria-hidden="true" />
            Running
          </span>
        )}
        <span className="pane-model" title={session.agentModel}>
          {label(session.agentModel)} · {EFFORT_NAMES[session.agentEffort]}
        </span>
        <SystemPrompt
          id={`system-prompt-${session.id}`}
          game={session}
          editable={editable}
          systemDraft={view?.systemPromptDraft ?? session.systemPrompt}
          changeSystemDraft={props.onSystemDraftChange}
          onPromptToggle={() => {
            if (controller.isSticking()) controller.scrollToEnd({ behavior: "instant" });
          }}
        />
      </header>
      <ScrollArea stickToEnd controller={controller} className="thread-area">
        <ScrollAreaViewport
          className="thread"
          role="region"
          tabIndex={0}
          aria-label={`Session ${session.ordinal} transcript`}
          aria-busy={!view?.fetched || !!view?.busy}
        >
          <ScrollAreaContent>
            <ThreadBody {...props} />
          </ScrollAreaContent>
        </ScrollAreaViewport>
      </ScrollArea>
      {editable && <Composer {...props} />}
    </section>
  );
}
