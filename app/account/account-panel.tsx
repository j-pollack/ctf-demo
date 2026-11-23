"use client";
import React, { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { DISPLAY_NAME_PATTERN } from "@/lib/display-name-rule";

export type AccountNotice = "confirmed" | "changed" | "link-error" | null;
export type AccountPanelProps = {
  email: string;
  displayName: string | null;
  // A validated path to continue to once a name is saved.
  next: string | null;
  notice: AccountNotice;
};

const message = (cause: unknown, fallback: string) =>
  cause instanceof Error && cause.message ? cause.message : fallback;

function Notice({ notice, email }: { notice: AccountNotice; email: string }) {
  if (notice === "link-error")
    return (
      <p role="alert" className="notice error">
        That link has expired or was already used. Ask for a new one below.
      </p>
    );
  if (notice === "confirmed")
    return (
      <p role="status" className="notice">
        Confirmed. Open the link we sent to your new address to finish the change.
      </p>
    );
  if (notice === "changed")
    return (
      <p role="status" className="notice">
        Your email is now {email}.
      </p>
    );
  return null;
}

function NameForm({
  displayName,
  next,
  onSaved,
}: Pick<AccountPanelProps, "displayName" | "next"> & { onSaved: (name: string) => void }) {
  const [name, setName] = useState(displayName ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const response = await fetch("/api/account/display-name", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: name }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        displayName?: string;
        error?: string;
      };
      if (!response.ok || !data.displayName)
        throw new Error(data.error ?? "Could not save your name. Try again.");
      setName(data.displayName);
      // A full load, so the game reads the account with its new name.
      if (next) return window.location.assign(next);
      setSaved(true);
      onSaved(data.displayName);
      authClient.$store.notify("$sessionSignal");
    } catch (cause) {
      setError(message(cause, "Could not save your name. Try again."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="account-form" onSubmit={save}>
      <label htmlFor="display-name">Display name</label>
      <p id="display-name-hint" className="hint">
        Shown on the leaderboard. 3 to 24 letters, digits, hyphens or underscores.
      </p>
      <input
        id="display-name"
        name="displayName"
        autoComplete="nickname"
        autoCapitalize="off"
        spellCheck={false}
        required
        minLength={3}
        maxLength={24}
        pattern={DISPLAY_NAME_PATTERN}
        // Choosing a name is the reason a nameless account is on this page.
        autoFocus={!displayName}
        aria-describedby="display-name-hint display-name-error"
        aria-invalid={!!error}
        value={name}
        onChange={(event) => {
          setName(event.target.value);
          setSaved(false);
        }}
      />
      <p id="display-name-error" role="alert" className="field-error">
        {error}
      </p>
      <button className="primary" disabled={busy}>
        {busy ? "Checking…" : next === "/play" ? "Save name and play" : "Save name"}
      </button>
      <p role="status" className="saved">
        {saved ? `Saved. The leaderboard now shows ${name}.` : ""}
      </p>
    </form>
  );
}

export type EmailFieldsProps = {
  email: string;
  value: string;
  // The address the last link was sent for, or "".
  sentTo: string;
  busy: boolean;
  error: string;
  onChange: (value: string) => void;
  onSubmit: (event: React.FormEvent) => void;
};

export function EmailFields({
  email,
  value,
  sentTo,
  busy,
  error,
  onChange,
  onSubmit,
}: EmailFieldsProps) {
  return (
    <form className="account-form" onSubmit={onSubmit}>
      <p>
        Signed in as <strong>{email}</strong>.
      </p>
      <label htmlFor="new-email">New email address</label>
      <p id="new-email-hint" className="hint">
        We send a link to your current address first, then one to the new address. Your email is
        never shown on the leaderboard.
      </p>
      <input
        id="new-email"
        type="email"
        autoComplete="email"
        required
        aria-describedby="new-email-hint new-email-error"
        aria-invalid={!!error}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="you@example.com"
      />
      <p id="new-email-error" role="alert" className="field-error">
        {error}
      </p>
      {/* Sends finish after the response, so the same request must not go twice. */}
      <button disabled={busy || (!!sentTo && value === sentTo)}>
        {busy ? "Sending…" : "Send confirmation link"}
      </button>
      <p role="status" className="saved">
        {sentTo
          ? `Check ${email} and open the link there. We then send a link to ${sentTo} to finish the change.`
          : ""}
      </p>
    </form>
  );
}

function EmailForm({ email }: { email: string }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sentTo, setSentTo] = useState("");
  async function request(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await authClient.changeEmail({ newEmail: value, callbackURL: "/account" });
      if (result.error) throw new Error(result.error.message ?? "");
      setSentTo(value);
      setValue("");
    } catch (cause) {
      setError(message(cause, "Could not send the link. Try again."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <EmailFields
      email={email}
      value={value}
      sentTo={sentTo}
      busy={busy}
      error={error}
      onChange={setValue}
      onSubmit={request}
    />
  );
}

export function AccountPanel({ email, displayName, next, notice }: AccountPanelProps) {
  // The name saved in this visit, so the setup notice goes once there is one.
  const [savedName, setSavedName] = useState(displayName);
  return (
    <main className="info account">
      <h2>Account</h2>
      <Notice notice={notice} email={email} />
      {!savedName && (
        <p role="status" className="notice">
          Choose a display name to finish setting up your account. You need one to start a run.
        </p>
      )}
      <section aria-labelledby="name-heading">
        <h3 id="name-heading">Leaderboard</h3>
        <NameForm displayName={displayName} next={next} onSaved={setSavedName} />
      </section>
      <section aria-labelledby="email-heading">
        <h3 id="email-heading">Email</h3>
        <EmailForm email={email} />
      </section>
    </main>
  );
}
