"use client";
import React from "react";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@ui-sdk/react/dialog";
import type { GameStatus } from "@/lib/types";

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

// New runs left in the day. Null is an admin with no limit; undefined is not known yet.
export function runsLeftText(runsLeft: number | null | undefined): string | null {
  if (runsLeft === null || runsLeft === undefined) return null;
  if (runsLeft <= 0) return "You have no runs left today.";
  return `You can start ${runsLeft} more ${runsLeft === 1 ? "run" : "runs"} today.`;
}

export function RunSetupNotes({
  endsCurrent,
  runsLeft,
  unusedRun,
}: {
  endsCurrent: boolean;
  runsLeft: number | null | undefined;
  unusedRun: boolean;
}) {
  const left = runsLeftText(runsLeft);
  return (
    <>
      {endsCurrent && <p>Starting a new run ends your current one.</p>}
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
  progress,
  onClose,
}: {
  // The investigator could not finish, so no result is coming from this review.
  unresolved: boolean;
  // Sessions still waiting, when the server reports them.
  progress: string | null;
  onClose: () => void;
}) {
  if (unresolved)
    return (
      <>
        <DialogTitle>The review could not be completed</DialogTitle>
        <p>
          Play has ended. The investigator could not finish reviewing this run, so the result is
          unconfirmed.
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
        Your agent submitted, so play has ended. The investigator is reading every session’s
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
