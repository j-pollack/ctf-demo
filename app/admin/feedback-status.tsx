import type { FeedbackState } from "@/lib/feedback-mail-text";

// "open" is a row Fastmail has not reported on yet: not closed, replied to or not.
export type StatusName = FeedbackState | "open";

const LABELS: Record<StatusName, string> = {
  waiting: "Needs reply",
  answered: "Answered",
  closed: "Closed",
  open: "Open",
};

export function FeedbackStatus({ state }: { state: StatusName }) {
  return (
    <span className="status" data-state={state}>
      {LABELS[state]}
    </span>
  );
}
