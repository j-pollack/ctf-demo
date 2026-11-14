"use client";
import React from "react";
import { Dialog, DialogClose, DialogContent } from "@ui-sdk/react/dialog";

export { DialogTitle } from "@ui-sdk/react/dialog";

// The setup and sign-in dialog. Escape, the backdrop and the close button dismiss it, except
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
