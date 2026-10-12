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
        {(
          [
            ["/rules", "Rules", "rules"],
            ["/rank", "Rank", "rank"],
            ["/runs", "My Runs", "history"],
          ] as const
        ).map(([href, label, key]) => (
          <Link key={href} href={href} aria-current={current === key ? "page" : undefined}>
            {label}
          </Link>
        ))}
        <span className="auth-nav">
          <AuthAction onSignIn={onSignIn} />
        </span>
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
      </nav>
    </header>
  );
}
