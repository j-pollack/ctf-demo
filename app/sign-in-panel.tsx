"use client";
import React from "react";

export type SignInPanelProps = {
  email: string;
  // A link was sent; the page says to check email instead of showing the form.
  sent: boolean;
  busy: boolean;
  error: string;
  onEmailChange: (email: string) => void;
  onSubmit: (event: React.FormEvent) => void;
};

export function SignInPanel({
  email,
  sent,
  busy,
  error,
  onEmailChange,
  onSubmit,
}: SignInPanelProps) {
  return (
    <main className="info sign-in">
      <h2>Sign in</h2>
      {sent ? (
        <p role="status">Check your email for a sign-in link. It expires in five minutes.</p>
      ) : (
        <form className="sign-in-form" onSubmit={onSubmit}>
          <p>
            Sign in to play. Enter your email and we’ll send you a link. Click it and you’re in, no
            password needed.
          </p>
          <label htmlFor="email">Email address</label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            required
            // The page's only purpose is this field.
            autoFocus
            value={email}
            onChange={(event) => onEmailChange(event.target.value)}
            placeholder="you@example.com"
          />
          <button className="primary" disabled={busy}>
            {busy ? "Sending…" : "Email me a link"}
          </button>
          <p className="hint">
            New here? After you open the link, you’ll choose a display name for the leaderboard.
          </p>
        </form>
      )}
      {error && (
        <div role="alert" className="error">
          {error}
        </div>
      )}
    </main>
  );
}
