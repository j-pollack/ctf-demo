"use client";
import React, { useState } from "react";
import { EMAIL_MAX, MESSAGE_MAX, NAME_MAX } from "@/lib/feedback-limits";

export function ContactForm() {
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
        body: JSON.stringify({
          kind: "contact",
          name: form.get("name"),
          email: form.get("email"),
          message: form.get("message"),
        }),
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Could not send your message. Try again.");
      setSent(true);
      element.reset();
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message
          ? cause.message
          : "Could not send your message. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="account-form" onSubmit={send}>
      <label htmlFor="contact-name">Name</label>
      <input
        id="contact-name"
        name="name"
        autoComplete="name"
        required
        maxLength={NAME_MAX}
        aria-describedby="contact-error"
        aria-invalid={!!error}
      />
      <label htmlFor="contact-email">Email</label>
      <input
        id="contact-email"
        name="email"
        type="email"
        autoComplete="email"
        required
        maxLength={EMAIL_MAX}
        aria-describedby="contact-error"
        aria-invalid={!!error}
      />
      <label htmlFor="contact-message">Message</label>
      <textarea
        id="contact-message"
        name="message"
        rows={8}
        required
        maxLength={MESSAGE_MAX}
        aria-describedby="contact-error"
        aria-invalid={!!error}
      />
      <p id="contact-error" role="alert" className="field-error">
        {error}
      </p>
      <button className="primary" aria-disabled={busy}>
        {busy ? "Sending…" : "Send"}
      </button>
      <p role="status" className="saved">
        {sent ? "Thanks. We got your message." : ""}
      </p>
      <p className="hint">We keep your name, email and message so we can reply.</p>
    </form>
  );
}
