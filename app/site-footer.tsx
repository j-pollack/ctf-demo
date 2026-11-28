import Link from "next/link";

// A link that leaves the site opens a new tab, and says so to sighted and screen-reader users.
function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <span aria-hidden="true"> ↗</span>
      <span className="visually-hidden"> (opens in a new tab)</span>
    </a>
  );
}

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
        <span data-testid="site-version">
          <ExternalLink href={`https://github.com/j-pollack/ctf-demo/commit/${sha}`}>
            <span className="visually-hidden">Version </span>
            {sha.slice(0, 7)}
          </ExternalLink>
        </span>
      )}
    </footer>
  );
}
