import { isIP } from "node:net";

const MAX_BODY_BYTES = 8192;
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{8,256}$/;
const DNS_HOSTNAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function validateFlagEndpoint(raw: string): { url: string; hostname: string } {
  const endpoint = new URL(raw);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.port ||
    endpoint.pathname !== "/v1/end" ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.username ||
    endpoint.password ||
    isIP(endpoint.hostname) !== 0 ||
    !DNS_HOSTNAME.test(endpoint.hostname) ||
    endpoint.toString() !== raw
  )
    throw new Error("Flag endpoint must be a canonical HTTPS /v1/end URL on port 443.");
  return { url: raw, hostname: endpoint.hostname };
}

// SITE_URL is this app's own override, and the only source outside Vercel. Vercel sets
// VERCEL_PROJECT_PRODUCTION_URL on previews too, so only production may use it.
export function configuredFlagEndpoint(env: Record<string, string | undefined> = process.env): {
  url: string;
  hostname: string;
} {
  const host =
    (env.VERCEL_ENV === "production" && env.VERCEL_PROJECT_PRODUCTION_URL) || env.VERCEL_URL;
  if (!env.SITE_URL && !host) throw new Error("A public HTTP submission origin is required.");
  const origin = env.SITE_URL ? env.SITE_URL.replace(/\/$/, "") : `https://${host}`;
  return validateFlagEndpoint(`${origin}/v1/end`);
}

/** For display only: null when the endpoint is not configured. Run creation fails closed. */
export function flagEndpointUrl(): string | null {
  try {
    return configuredFlagEndpoint().url;
  } catch {
    return null;
  }
}

export function parseSubmissionRequest(
  headers: Headers,
): { gameId: string; token: string } | { status: number } {
  if (headers.has("origin") || headers.has("content-encoding")) return { status: 400 };
  const transferEncoding = headers.get("transfer-encoding");
  if (transferEncoding !== null && transferEncoding !== "chunked") return { status: 400 };
  if (headers.get("content-type") !== "application/octet-stream") return { status: 415 };
  const contentLength = headers.get("content-length");
  if (transferEncoding && contentLength !== null) return { status: 400 };
  if (
    contentLength !== null &&
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
