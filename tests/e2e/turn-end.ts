// What ended an agent's turn, decided from what the database holds. No imports, so offline tests
// can load it.
export const OPEN_STATUSES = ["creating", "active", "finalizing"];

export type StoredEvent = {
  kind: string;
  text?: string;
  resumable?: boolean;
  autoContinue?: boolean;
};
export type TurnEnd = { kind: "over" | "reply" | "error"; text: string } | undefined;

// `events` are the run's user, agent and error events after the instruction, oldest first. A run
// that is no longer open is over whatever else holds. Otherwise the turn is over only when no lease
// is live and the newest event is a reply or an error. An error the server marks `autoContinue` is
// followed by the page's own "Continue." turn, with no live lease between the two, so it is not an
// end. A "Continue." user event means a turn is starting.
export function turnEnd(input: {
  status: string;
  leased: boolean;
  events: StoredEvent[];
}): TurnEnd {
  if (!OPEN_STATUSES.includes(input.status)) return { kind: "over", text: input.status };
  if (input.leased) return undefined;
  const last = input.events.at(-1);
  if (last?.kind === "agent") return { kind: "reply", text: last.text ?? "" };
  if (last?.kind === "error" && !(last.resumable && last.autoContinue))
    return { kind: "error", text: last.text ?? "" };
  return undefined;
}
