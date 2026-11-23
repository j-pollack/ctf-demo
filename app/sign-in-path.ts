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

// Where a member without a display name chooses one, returning to `next` afterwards.
export function accountPath(next: string): string {
  return `/account?next=${encodeURIComponent(safeNextPath(next))}`;
}

// The account page's own parameters, kept through a sign-in round trip so an email link's outcome
// still shows afterwards. Only known keys with single values are kept; the account page validates
// `next` again when it uses it.
const ACCOUNT_KEYS = ["next", "email", "error"] as const;
export function accountSignInPath(search: Record<string, string | string[] | undefined>): string {
  const kept = new URLSearchParams();
  for (const key of ACCOUNT_KEYS) {
    const value = search[key];
    if (typeof value === "string") kept.set(key, value);
  }
  return signInPath(kept.size ? `/account?${kept}` : "/account");
}

// Where signing out goes. The account page shows server-rendered account data, so it leaves for
// sign-in; any other page stays and refreshes.
export function signOutDestination(pathname: string): string | null {
  return pathname === "/account" ? signInPath("/account") : null;
}
