export const DEFAULT_NEXT = "/play";
const MAX_LENGTH = 512;
const ORIGIN = "https://site.invalid";
// Control characters, including tab and newline, which URL parsers strip or split on.
const hasControl = (value: string) =>
  [...value].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f);

// A root-relative path that cannot leave this site, resolved: one leading slash, no backslash or
// control character, the same origin, and no dot segments left to collapse into "//host".
function localPath(value: string): string | null {
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  if (value.includes("\\") || hasControl(value)) return null;
  try {
    const url = new URL(value, ORIGIN);
    if (url.origin !== ORIGIN || url.pathname.startsWith("//")) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

// `next` is untrusted. The resolved path is what is returned, never the raw value. It must also
// stay local once percent-decoded, because the magic link verifier decodes `callbackURL` once
// more before redirecting.
export function safeNextPath(value: string | null | undefined): string {
  if (!value || value.length > MAX_LENGTH) return DEFAULT_NEXT;
  const resolved = localPath(value);
  if (!resolved) return DEFAULT_NEXT;
  let decoded: string | null;
  try {
    decoded = localPath(decodeURIComponent(resolved));
  } catch {
    return DEFAULT_NEXT;
  }
  if (!decoded) return DEFAULT_NEXT;
  const { pathname } = new URL(decoded, ORIGIN);
  if (pathname === "/signin" || pathname.startsWith("/signin/")) return DEFAULT_NEXT;
  return resolved;
}

export function signInPath(next: string): string {
  return `/signin?next=${encodeURIComponent(safeNextPath(next))}`;
}
