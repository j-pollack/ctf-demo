"use client";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AccountMenu } from "@/app/account-menu";
import { authClient } from "@/lib/auth-client";
import { signInPath, signOutDestination } from "@/app/sign-in-path";

// Only a member's header needs the router, so a signed-out header renders outside Next's router too.
function SignedIn({ current, onSignedOut }: { current?: string | null; onSignedOut: () => void }) {
  const [error, setError] = useState("");
  const pathname = usePathname();
  const router = useRouter();
  // Never rejects, so the menu closes either way; a failure shows beside it.
  async function signOut() {
    setError("");
    try {
      const result = await authClient.signOut();
      if (result.error) throw new Error(result.error.message ?? "Could not sign out. Try again.");
      const destination = signOutDestination(pathname);
      if (destination) return router.replace(destination);
      onSignedOut();
      // Server-rendered parts of the page were rendered for the signed-in account.
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not sign out. Try again.");
    }
  }
  return (
    <>
      <AccountMenu current={current} onSignOut={signOut} />
      {error && <span role="alert">{error}</span>}
    </>
  );
}

export default function AuthAction({
  current,
  onSignIn,
}: {
  current?: string | null;
  onSignIn?: () => void;
}) {
  const { data, isPending } = authClient.useSession();
  const signedIn = !!data && !data.user.isAnonymous;
  // The menu's trigger goes away on sign-out, so focus moves to the Sign in control that replaces it.
  const focusSignIn = useRef(false);
  const signInControl = useRef<HTMLButtonElement & HTMLAnchorElement>(null);
  useEffect(() => {
    if (signedIn || isPending || !focusSignIn.current) return;
    focusSignIn.current = false;
    signInControl.current?.focus();
  }, [signedIn, isPending]);
  if (isPending)
    return (
      <button disabled aria-busy="true">
        Loading…
      </button>
    );
  return signedIn ? (
    <SignedIn current={current} onSignedOut={() => (focusSignIn.current = true)} />
  ) : onSignIn ? (
    <button ref={signInControl} onClick={onSignIn}>
      Sign in
    </button>
  ) : (
    <a ref={signInControl} className="landing-signin" href={signInPath("/play")}>
      Sign in
    </a>
  );
}
