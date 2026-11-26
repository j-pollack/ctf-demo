"use client";
import React, { useState } from "react";
import { DialogTitle, RunDialog } from "@/app/run-dialog";
import { PENDING_SESSION } from "@/app/session-layout";
import { MESSAGE_MAX } from "@/lib/feedback-limits";

export type ReportKind = "bug" | "monitor" | "other";

// The placeholder is not a stored session, so only a real focused session is named.
export function reportBody(
  gameId: string,
  focusedId: string | null,
  kind: ReportKind,
  message: string,
) {
  const sessionId = focusedId && focusedId !== PENDING_SESSION ? focusedId : undefined;
  return { kind, gameId, ...(sessionId && { sessionId }), message };
}

export function ReportForm({ gameId, focusedId }: { gameId: string; focusedId: string | null }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  async function send(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // The button stays focusable while sending, so a second submit is ignored here.
    if (busy) return;
    const element = event.currentTarget;
    const form = new FormData(element);
    setBusy(true);
    setError("");
    setSent(false);
    try {
      const response = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          reportBody(
            gameId,
            focusedId,
            form.get("kind") as ReportKind,
            String(form.get("message")),
          ),
        ),
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Could not send your report. Try again.");
      setSent(true);
      element.reset();
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message
          ? cause.message
          : "Could not send your report. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="report-form" onSubmit={send}>
      <label htmlFor="report-kind">What went wrong?</label>
      <select id="report-kind" name="kind" defaultValue="bug" data-testid="report-kind">
        <option value="bug">Something is broken</option>
        <option value="monitor">The monitor got it wrong</option>
        <option value="other">Something else</option>
      </select>
      <label htmlFor="report-message">Message</label>
      <textarea
        id="report-message"
        name="message"
        rows={5}
        required
        maxLength={MESSAGE_MAX}
        aria-describedby="report-error"
        aria-invalid={!!error}
        data-testid="report-message"
      />
      <p className="hint">Your run and session IDs are sent with the report.</p>
      <p id="report-error" role="alert" className="field-error">
        {error}
      </p>
      <button className="primary" aria-disabled={busy} data-testid="report-submit">
        {busy ? "Sending…" : "Send"}
      </button>
      <p
        role="status"
        className="saved"
        data-testid="report-status"
        data-state={sent ? "sent" : "idle"}
      >
        {sent ? "Thanks. We got your report." : ""}
      </p>
    </form>
  );
}

export function ReportProblem({ gameId, focusedId }: { gameId: string; focusedId: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} data-testid="report-open">
        Report
      </button>
      <RunDialog open={open} busy={false} onClose={() => setOpen(false)}>
        <DialogTitle>Report a problem</DialogTitle>
        <ReportForm gameId={gameId} focusedId={focusedId} />
      </RunDialog>
    </>
  );
}
