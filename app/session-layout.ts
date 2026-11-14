import type { GameEvent, GameStatus } from "@/lib/types";

export const PANE_MIN = 400;
export const INSPECTOR_WIDTH = 320;
export type InspectorMode = "closed" | "column" | "overlay";

const fits = (width: number) => Math.floor(width / PANE_MIN);

// Before the first measurement the width is null: one pane, inspector closed.
export function paneCapacity(width: number | null) {
  return width === null ? 1 : Math.max(1, fits(width));
}

// The inspector opens by default only when it costs no pane. The player's choice then wins.
export function deckLayout(
  width: number | null,
  sessions: number,
  choice: boolean | null,
): { capacity: number; inspector: InspectorMode } {
  if (width === null) return { capacity: 1, inspector: "closed" };
  const full = paneCapacity(width),
    beside = width - INSPECTOR_WIDTH;
  const open = choice ?? (full > 1 && fits(beside) >= Math.min(sessions, full));
  if (!open) return { capacity: full, inspector: "closed" };
  if (beside < PANE_MIN) return { capacity: full, inspector: "overlay" };
  return { capacity: paneCapacity(beside), inspector: "column" };
}

// Most recently focused first. Unknown ids are ignored.
export function focusRecent(recent: string[], id: string, ids: string[]) {
  if (!ids.includes(id)) return recent;
  return [id, ...recent.filter((item) => item !== id && ids.includes(item))];
}

// Focus moves from one session to another. The outgoing one is recorded first, because focus
// set by the URL or by hydration never went through here.
export function handOffFocus(recent: string[], from: string | null, to: string, ids: string[]) {
  return focusRecent(from === null ? recent : focusRecent(recent, from, ids), to, ids);
}

// Recently focused sessions keep their panes; free panes fill in ordinal order.
export function shownSessionIds(ids: string[], recent: string[], capacity: number) {
  const kept = recent.filter((id) => ids.includes(id)).slice(0, capacity);
  const filler = ids.filter((id) => !kept.includes(id)).slice(0, capacity - kept.length);
  return ids.filter((id) => kept.includes(id) || filler.includes(id));
}

// Which shown sessions to fetch: those not already loaded while shown in this run.
export function nextShownLoads(
  loaded: ReadonlySet<string>,
  runId: string | null,
  shown: string[],
): { load: string[]; loaded: Set<string> } {
  if (runId === null) return { load: [], loaded: new Set() };
  const key = (id: string) => `${runId}:${id}`;
  return {
    load: shown.filter((id) => !loaded.has(key(id))),
    loaded: new Set(shown.map(key)),
  };
}

export const PENDING_SESSION = "pending-session";

// While a new session is being created it is shown and focused under a placeholder id, after
// every real session, so the real one later lands in the same pane.
export function deckSessions(ids: string[], recent: string[], capacity: number, pending: boolean) {
  if (!pending) return shownSessionIds(ids, recent, capacity);
  const all = [...ids, PENDING_SESSION];
  return shownSessionIds(all, focusRecent(recent, PENDING_SESSION, all), capacity);
}

// Which edges of a scrolling strip have content beyond them, ignoring sub-pixel scroll.
export function stripEdges(strip: {
  scrollLeft: number;
  clientWidth: number;
  scrollWidth: number;
}) {
  return {
    start: strip.scrollLeft > 1,
    end: strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1,
  };
}

export function sessionTurns(summaryTurns: number, events: GameEvent[]) {
  return events.reduce(
    (turns, event) => (event.kind === "agent" ? Math.max(turns, event.turn ?? 0) : turns),
    summaryTurns,
  );
}

// The turn count the player last saw per session. Shown sessions are seen as they change.
export function nextSeenTurns(
  seen: Record<string, number>,
  sessions: { id: string; turns: number }[],
  shown: string[],
) {
  let next = seen;
  for (const session of sessions) {
    const value = shown.includes(session.id) ? session.turns : (seen[session.id] ?? session.turns);
    if (next[session.id] !== value) next = { ...next, [session.id]: value };
  }
  return next;
}

export type ChipState = {
  ordinal: number;
  turns: number;
  running: boolean;
  caught: boolean;
  shown: boolean;
  focused: boolean;
  unseen: boolean;
};

export function chipLabel(chip: ChipState) {
  return [
    `Session ${chip.ordinal}`,
    `${chip.turns} ${chip.turns === 1 ? "turn" : "turns"}`,
    chip.running && "running",
    chip.caught && "caught",
    chip.focused ? "focused" : chip.shown ? "shown" : "hidden",
    chip.unseen && "new turns",
  ]
    .filter(Boolean)
    .join(", ");
}

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
