"use client";
import React from "react";
import { Dialog, DialogClose, DialogContent } from "@ui-sdk/react/dialog";

export { DialogTitle } from "@ui-sdk/react/dialog";

// The setup dialog. Escape, the backdrop and the close button dismiss it, except
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
