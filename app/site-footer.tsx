import Link from "next/link";

export default function SiteFooter() {
  return (
    <footer className="site-footer">
      <a href="https://jonathanpollack.net" target="_blank" rel="noopener noreferrer">
        Jonathan Pollack
      </a>
      <a href="https://github.com/j-pollack/ctf-demo" target="_blank" rel="noopener noreferrer">
        Source on GitHub
      </a>
      <Link href="/contact">Contact</Link>
    </footer>
  );
}
