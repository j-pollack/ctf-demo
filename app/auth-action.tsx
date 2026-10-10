"use client";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";

export default function AuthAction({ onSignIn }: { onSignIn?: () => void }) {
  const { data, isPending } = authClient.useSession();
  const signedIn = !!data && !data.user.isAnonymous;
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  async function signOut() {
    setPending(true);
    setError("");
    try {
      const result = await authClient.signOut();
      if (result.error)
        throw new Error(result.error.message ?? "Could not sign out. Please retry.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not sign out. Please retry.");
    } finally {
      setPending(false);
    }
  }
  if (isPending)
    return (
      <button disabled aria-busy="true">
        Loading…
      </button>
    );
  return signedIn ? (
    <>
      <button onClick={() => void signOut()} disabled={pending}>
        {pending ? "Signing out…" : "Sign out"}
      </button>
      {error && <span role="alert">{error}</span>}
    </>
  ) : onSignIn ? (
    <button onClick={onSignIn}>Sign in</button>
  ) : (
    <a className="landing-signin" href="/play?signin=1">
      Sign in ↗
    </a>
  );
}
