import { isIP } from "node:net";

const MAX_BODY_BYTES = 8192;
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{8,256}$/;
const DNS_HOSTNAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function validHostname(hostname: string): boolean {
  return (
    !hostname.includes(":") &&
    isIP(hostname) === 0 &&
    DNS_HOSTNAME.test(hostname) &&
    hostname !== "localhost"
  );
}

export function validateFlagEndpoint(raw: string): { url: string; hostname: string } {
  const endpoint = new URL(raw);
  if (
    endpoint.protocol !== "https:" ||
    (endpoint.port !== "" && endpoint.port !== "443") ||
    endpoint.pathname !== "/v1/end" ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.username ||
    endpoint.password ||
    !validHostname(endpoint.hostname) ||
    endpoint.toString() !== raw
  )
    throw new Error("Flag endpoint must be a canonical HTTPS /v1/end URL on port 443.");
  return { url: endpoint.toString(), hostname: endpoint.hostname };
}

export function configuredFlagEndpoint(env: Record<string, string | undefined> = process.env): {
  url: string;
  hostname: string;
} {
  let origin: string;
  if (env.SITE_URL) {
    const raw = env.SITE_URL;
    const site = new URL(raw);
    if (
      site.protocol !== "https:" ||
      site.port ||
      site.username ||
      site.password ||
      site.pathname !== "/" ||
      site.search ||
      site.hash ||
      !validHostname(site.hostname) ||
      (raw !== site.origin && raw !== site.toString())
    )
      throw new Error("SITE_URL must be a canonical public HTTPS origin.");
    origin = site.origin;
  } else {
    const host =
      env.VERCEL_ENV === "production" && env.VERCEL_PROJECT_PRODUCTION_URL
        ? env.VERCEL_PROJECT_PRODUCTION_URL
        : env.VERCEL_URL;
    if (!host) throw new Error("A public HTTP submission origin is required.");
    if (!validHostname(host)) throw new Error("Vercel submission host must be canonical DNS.");
    origin = `https://${host}`;
  }
  return validateFlagEndpoint(`${origin}/v1/end`);
}

export function parseSubmissionRequest(input: {
  method?: string;
  url?: string;
  rawHeaders: string[];
}): { gameId: string; token: string } | { status: number } {
  if (input.url !== "/v1/end") return { status: 404 };
  if (input.method !== "POST") return { status: 405 };
  if (input.rawHeaders.length % 2 !== 0) return { status: 400 };
  const headers = new Map<string, string>();
  const security = new Set([
    "authorization",
    "x-ctf-run-id",
    "content-type",
    "content-length",
    "transfer-encoding",
    "content-encoding",
    "origin",
    "host",
  ]);
  for (let i = 0; i < input.rawHeaders.length; i += 2) {
    const name = input.rawHeaders[i].toLowerCase();
    if (security.has(name) && headers.has(name)) return { status: 400 };
    headers.set(name, input.rawHeaders[i + 1]);
  }
  if (headers.has("origin") || headers.has("content-encoding")) return { status: 400 };
  const transferEncoding = headers.get("transfer-encoding");
  if (transferEncoding !== undefined && transferEncoding !== "chunked") return { status: 400 };
  if (headers.get("content-type") !== "application/octet-stream") return { status: 415 };
  const contentLength = headers.get("content-length");
  if (transferEncoding && contentLength !== undefined) return { status: 400 };
  if (
    contentLength !== undefined &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES)
  )
    return { status: 413 };
  const gameId = headers.get("x-ctf-run-id") ?? "";
  const bearer = headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]+)$/);
  if (!RUN_ID.test(gameId) || !bearer || !TOKEN.test(bearer[1])) return { status: 401 };
  return { gameId: gameId.toLowerCase(), token: bearer[1] };
}

export function decodeSubmissionBody(chunks: Uint8Array[]): string | null {
  let size = 0;
  for (const chunk of chunks) {
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) return null;
  }
  if (size === 0) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      Buffer.concat(chunks, size),
    );
  } catch {
    return null;
  }
}

export { MAX_BODY_BYTES };
