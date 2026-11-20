import type { AgentEffort, GameEvent, PublicGame, SessionSummary } from "@/lib/types";
import type { LiveTurn } from "@/app/transcript";

export type SessionUIState = {
  id: string;
  draft: string;
  agentModel?: string;
  agentEffort?: AgentEffort;
  systemPromptDraft?: string;
  // The stored system prompt the draft was last based on.
  systemPrompt?: string;
  busy: boolean;
  cursor: number;
  stage: string;
  error: string;
  events: GameEvent[];
  // Whether a fetch has loaded this session's events. Stream events alone do not count.
  fetched: boolean;
  // The agent turn being streamed; the recorded agent event replaces it.
  live?: LiveTurn;
  pending?: { gameId: string; text: string; afterId: number };
  unconfirmed: boolean;
  // A stop was requested and the session is still busy.
  stopping: boolean;
};

export type SessionUIMap = Record<string, SessionUIState>;

export type SessionCreateFence = {
  request: number;
  owner: string | undefined;
  epoch: number;
  runId: string;
};

export function isCurrentSessionCreateFence(
  origin: SessionCreateFence,
  current: SessionCreateFence,
): boolean {
  return (
    origin.request === current.request &&
    origin.owner === current.owner &&
    origin.epoch === current.epoch &&
    origin.runId === current.runId
  );
}

export function isTerminalRunStatus(status: PublicGame["status"]): boolean {
  return ["caught", "captured", "exhausted", "ended", "blocked"].includes(status);
}

export function preserveTerminalRunState(current: PublicGame, next: PublicGame): PublicGame {
  if (!isTerminalRunStatus(current.status) || isTerminalRunStatus(next.status)) return next;
  return {
    ...next,
    status: current.status,
    busy: current.busy,
    sessionBusy: current.sessionBusy,
    sessions: current.sessions,
    tokenBudget: current.tokenBudget,
    tokensUsed: current.tokensUsed,
    budgetMicrodollars: current.budgetMicrodollars,
    spentMicrodollars: current.spentMicrodollars,
    reservedMicrodollars: current.reservedMicrodollars,
    agentSpendMicrodollars: current.agentSpendMicrodollars,
    monitorSpendMicrodollars: current.monitorSpendMicrodollars,
    turns: current.turns,
    blocks: current.blocks,
    caughtSessionId: current.caughtSessionId,
    caughtSessionOrdinal: current.caughtSessionOrdinal,
    caughtReason: current.caughtReason,
    caughtCause: current.caughtCause,
    refusedTexts: current.refusedTexts,
  };
}

export function applyRunFinalizingState(run: PublicGame, sessionId: string): PublicGame {
  if (isTerminalRunStatus(run.status)) return run;
  return {
    ...run,
    status: "finalizing",
    busy: true,
    ...(run.sessionId === sessionId && { sessionBusy: true }),
    sessions: run.sessions?.map((session) =>
      session.id === sessionId ? { ...session, busy: true } : session,
    ),
  };
}

export function projectSelectedSession(
  run: PublicGame,
  session: SessionSummary | undefined,
  events: GameEvent[],
): PublicGame {
  return {
    ...run,
    ...(session && {
      sessionId: session.id,
      agentModel: session.agentModel,
      agentEffort: session.agentEffort,
      systemPrompt: session.systemPrompt,
      sessionBusy: session.busy,
    }),
    events,
  };
}

export function runHasStarted(run: PublicGame, views: SessionUIMap): boolean {
  if (run.turns > 0 || run.events.some((event) => event.id > 0 && event.kind === "user"))
    return true;
  return run.sessions.some(
    (session) =>
      session.turns > 0 ||
      session.busy ||
      views[session.id]?.events.some((event) => event.id > 0 && event.kind === "user"),
  );
}

export function createSessionUIState(
  session: Pick<SessionSummary, "id"> & Partial<SessionSummary> & { events?: GameEvent[] },
): SessionUIState {
  const events = session.events ?? [];
  return {
    id: session.id,
    draft: "",
    agentModel: session.agentModel,
    agentEffort: session.agentEffort,
    systemPromptDraft: session.systemPrompt,
    systemPrompt: session.systemPrompt,
    busy: session.busy ?? false,
    cursor: events.reduce((maximum, event) => Math.max(maximum, event.id), 0),
    stage: "",
    error: "",
    events,
    fetched: session.events !== undefined,
    unconfirmed: false,
    stopping: false,
  };
}

// Only the run's own session arrives with its events; siblings start unfetched.
export function newSessionView(
  run: Pick<PublicGame, "sessionId" | "events">,
  summary: Pick<SessionSummary, "id"> & Partial<SessionSummary>,
): SessionUIState {
  return createSessionUIState({
    ...summary,
    events: summary.id === run.sessionId ? run.events : undefined,
  });
}

// The requested session when it belongs to this run, otherwise the run's own session.
export function pickSession(run: PublicGame, requested: string | null): string {
  const ids = run.sessions?.length
    ? run.sessions.map((session) => session.id)
    : [run.sessionId || run.id];
  return requested && ids.includes(requested) ? requested : (run.sessionId ?? run.id);
}

export function sessionLoading(run: PublicGame, views: SessionUIMap, id: string): boolean {
  const view = views[id],
    summary = run.sessions?.find((session) => session.id === id);
  return (view?.busy ?? summary?.busy ?? run.sessionBusy ?? false) || !!view?.unconfirmed;
}

export function setSessionBusy(
  state: SessionUIMap,
  id: string,
  busy: boolean,
  stage: string,
): SessionUIMap {
  const session = state[id];
  if (!session) return state;
  return { ...state, [id]: { ...session, busy, stage, stopping: busy && session.stopping } };
}

// Stream events are useful for immediate display, but only a fetched snapshot confirms a cursor.
export function mergeSessionEvent(state: SessionUIMap, id: string, event: GameEvent): SessionUIMap {
  const session = state[id];
  if (!session) return state;
  const heldEvents =
    event.kind === "user"
      ? session.events.filter(
          (item) => !(item.id < 0 && item.kind === "user" && item.text === event.text),
        )
      : session.events;
  const events = heldEvents.some((item) => item.id === event.id)
    ? heldEvents.map((item) => (item.id === event.id ? event : item))
    : [...heldEvents, event].sort((left, right) => {
        if (left.id < 0) return 1;
        if (right.id < 0) return -1;
        return left.id - right.id;
      });
  return { ...state, [id]: { ...session, events } };
}

export function applySessionSnapshot(
  state: SessionUIMap,
  id: string,
  fetchedEvents: GameEvent[],
  confirmedCursor: number,
): SessionUIMap {
  const session = state[id];
  if (!session) return state;
  const events = new Map(session.events.map((event) => [event.id, event]));
  fetchedEvents.forEach((event) => {
    if (event.kind === "user")
      for (const [id, held] of events)
        if (id < 0 && held.kind === "user" && held.text === event.text) events.delete(id);
    events.set(event.id, event);
  });
  return {
    ...state,
    [id]: {
      ...session,
      events: [...events.values()].sort((left, right) => left.id - right.id),
      cursor: Math.max(session.cursor, confirmedCursor),
      fetched: true,
    },
  };
}

export function stopAllSessions(state: SessionUIMap): SessionUIMap {
  return Object.fromEntries(
    Object.entries(state).map(([id, session]) => [
      id,
      {
        ...session,
        busy: false,
        stage: "",
        live: undefined,
        pending: undefined,
        unconfirmed: false,
        stopping: false,
      },
    ]),
  );
}

export function keepSelectedSessionProjection(
  current: PublicGame,
  next: PublicGame,
  authoritative = false,
): PublicGame {
  const projected = preserveTerminalRunState(current, next);
  const selected = projected.sessions?.find((session) => session.id === current.sessionId);
  const preserveFinalizing =
    !authoritative && current.status === "finalizing" && next.status === "active";
  return {
    ...current,
    ...projected,
    status: preserveFinalizing ? current.status : projected.status,
    sessionId: current.sessionId,
    agentModel: selected?.agentModel ?? current.agentModel,
    agentEffort: selected?.agentEffort ?? current.agentEffort,
    systemPrompt: selected?.systemPrompt ?? current.systemPrompt,
    sessionBusy: selected?.busy ?? current.sessionBusy,
    events: current.events,
  };
}
