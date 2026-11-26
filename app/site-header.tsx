"use client";
import Link from "next/link";
import AuthAction from "@/app/auth-action";

export default function SiteHeader({
  current,
  onPlay,
  onSignIn,
}: {
  current?: string | null;
  onPlay?: () => void;
  onSignIn?: () => void;
}) {
  return (
    <header className="top">
      <Link href="/" className="wordmark" aria-label="Capture the flag home">
        <span className="brand-full">Capture the flag</span>
        <span className="brand-short" aria-hidden="true">
          CTF
        </span>
        <span aria-hidden="true">_</span>
      </Link>
      <nav aria-label="Main navigation">
        <Link
          href="/rules"
          // The visible text shortens on the narrowest screens, so the name says it in full.
          aria-label="How to play"
          aria-current={current === "rules" ? "page" : undefined}
        >
          <span className="nav-full">How to play</span>
          <span className="nav-short" aria-hidden="true">
            How to
          </span>
        </Link>
        {(
          [
            ["/rank", "Rankings", "rank"],
            ["/runs", "My Runs", "history"],
          ] as const
        ).map(([href, label, key]) => (
          <Link key={href} href={href} aria-current={current === key ? "page" : undefined}>
            {label}
          </Link>
        ))}
        {onPlay ? (
          <button
            className={current === "play" ? undefined : "primary"}
            aria-current={current === "play" ? "page" : undefined}
            onClick={onPlay}
          >
            Play
          </button>
        ) : (
          <Link
            className={current === "play" ? undefined : "primary"}
            href="/play"
            aria-current={current === "play" ? "page" : undefined}
          >
            Play
          </Link>
        )}
        <span className="auth-nav">
          <AuthAction current={current} onSignIn={onSignIn} />
        </span>
      </nav>
    </header>
  );
}
