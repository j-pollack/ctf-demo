import Link from "next/link";

// A link that leaves the site opens a new tab, and says so to sighted and screen-reader users.
function ExternalLink({
  href,
  children,
  testId,
}: {
  href: string;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" data-testid={testId}>
      {children}
      <span aria-hidden="true"> ↗</span>
      <span className="visually-hidden"> (opens in a new tab)</span>
    </a>
  );
}

// Inlined at build time by `env` in next.config.ts, so server and client renders agree.
function buildCommit() {
  const sha = process.env.BUILD_COMMIT_SHA;
  return sha && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

export default function SiteFooter() {
  const sha = buildCommit();
  return (
    <footer className="site-footer">
      <ExternalLink href="https://jonathanpollack.net">Jonathan Pollack</ExternalLink>
      <ExternalLink href="https://github.com/j-pollack/ctf-demo">Source on GitHub</ExternalLink>
      <Link href="/contact">Contact</Link>
      {sha && (
        <ExternalLink
          href={`https://github.com/j-pollack/ctf-demo/commit/${sha}`}
          testId="site-version"
        >
          {sha.slice(0, 7)}
        </ExternalLink>
      )}
    </footer>
  );
}
