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

export default function SiteFooter() {
  return (
    <footer className="site-footer">
      <ExternalLink href="https://jonathanpollack.net">Jonathan Pollack</ExternalLink>
      <ExternalLink href="https://github.com/j-pollack/ctf-demo">Source on GitHub</ExternalLink>
      <Link href="/contact">Contact</Link>
    </footer>
  );
}
