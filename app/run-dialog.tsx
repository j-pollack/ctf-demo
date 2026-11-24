"use client";
import React from "react";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@ui-sdk/react/dialog";
import { REVIEW_WILL_RETRY_TEXT } from "@/app/run-format";
import { RUNS_PER_DAY, type GameStatus } from "@/lib/types";

export { DialogTitle } from "@ui-sdk/react/dialog";

// The setup dialog, and the notice that a submitted run is under review. Escape, the backdrop and the close button dismiss it, except
// while a run-level action is busy.
export function RunDialog({
  open,
  busy,
  onClose,
  children,
}: {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      dismissible={!busy}
    >
      <DialogContent render={<dialog />}>
        <div className="dialog-content">
          <DialogClose className="close" aria-label="Close dialog" disabled={busy}>
            ×
          </DialogClose>
          {children}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// New runs left under the limit on starts in the last 24 hours. Null is an admin with no limit;
// undefined is not known yet.
export function runsLeftText(runsLeft: number | null | undefined): string | null {
  if (runsLeft === null || runsLeft === undefined) return null;
  if (runsLeft <= 0) return `You have started ${RUNS_PER_DAY} new runs in the last 24 hours.`;
  return `You can start ${runsLeft} more ${runsLeft === 1 ? "run" : "runs"} now.`;
}

export function RunSetupNotes({
  endsCurrent,
  grading = false,
  runsLeft,
  unusedRun,
}: {
  endsCurrent: boolean;
  // The current run holds an upload that is waiting to be graded, so a new run is refused.
  grading?: boolean;
  runsLeft: number | null | undefined;
  unusedRun: boolean;
}) {
  const left = runsLeftText(runsLeft);
  return (
    <>
      {grading ? (
        <p>
          Your current run’s upload is waiting to be graded. You can start a new run once grading
          begins.
        </p>
      ) : (
        endsCurrent && <p>Starting a new run ends your current one.</p>
      )}
      {left && <p>{left}</p>}
      {unusedRun && <p>You already have an unused run. Send it an instruction first.</p>}
    </>
  );
}

// A submitted run waits for the investigator before its result is known. The notice covers the
// page until then, unless the player has dismissed it for this run to keep reading.
export function reviewNoticeOpen(
  run: { id: string; status: GameStatus } | null | undefined,
  dismissedFor: string | null,
) {
  return !!run && run.status === "finalizing" && run.id !== dismissedFor;
}

export function ReviewNotice({
  unresolved,
  settling = false,
  reason,
  willRetry = false,
  progress,
  onClose,
}: {
  // The investigator could not finish, so no result is coming from this review.
  unresolved: boolean;
  // A stopped command is being checked before the run can be graded.
  settling?: boolean;
  // What the server says about the state, shown as it is.
  reason?: string;
  // The failed review is requeued, so the result is not final yet.
  willRetry?: boolean;
  // Sessions still waiting, when the server reports them.
  progress: string | null;
  onClose: () => void;
}) {
  if (unresolved || settling)
    return (
      <>
        <DialogTitle>
          {settling
            ? "The result is not ready yet"
            : willRetry
              ? "The review failed"
              : "Play has ended"}
        </DialogTitle>
        <p>
          {settling
            ? (reason ?? "A stopped command is being checked. This takes a few seconds.")
            : willRetry
              ? REVIEW_WILL_RETRY_TEXT
              : (reason ??
                "The review could not be completed. If the monitor cannot clear the run, it ends with no result, which is not a win.")}
        </p>
        <button type="button" className="primary" onClick={onClose}>
          Read the transcripts
        </button>
      </>
    );
  return (
    <>
      <DialogTitle>The investigator is reviewing this run</DialogTitle>
      <p>
        The flag was uploaded, so play has ended. The investigator is reading every session’s
        transcript before the result is confirmed. This can take a minute or two.
      </p>
      <p role="status" className="stage">
        <i aria-hidden="true" />
        {progress ?? "Review in progress."}
      </p>
      <button type="button" className="primary" onClick={onClose}>
        Read the transcripts while you wait
      </button>
    </>
  );
}
