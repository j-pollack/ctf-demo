import {
  configuredFlagEndpoint,
  decodeSubmissionBody,
  MAX_BODY_BYTES,
  parseSubmissionRequest,
} from "@/lib/flag-submission-protocol";
import { receiveFlagSubmission } from "@/lib/flag-submissions";

export const runtime = "nodejs";
export const maxDuration = 30;

const READ_TIMEOUT_MS = 5000;

function cancelBody(reader: ReadableStreamDefaultReader<Uint8Array>) {
  void reader.cancel().catch(() => console.error("Flag route body cancellation failed."));
}

function respond(status: number): Response {
  return new Response(status === 202 ? "Accepted\n" : "Request rejected\n", {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

async function readBody(request: Request): Promise<{ value: string } | { status: number }> {
  const reader = request.body?.getReader();
  if (!reader) return { status: 400 };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let stopped: "timeout" | "aborted" | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const interruption = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      stopped = "timeout";
      reject(new Error("Request read timed out."));
    }, READ_TIMEOUT_MS);
    onAbort = () => {
      stopped = "aborted";
      reject(new Error("Request was aborted."));
    };
    request.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    if (request.signal.aborted) {
      cancelBody(reader);
      return { status: 400 };
    }
    while (true) {
      const { done, value } = await Promise.race([reader.read(), interruption]);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        cancelBody(reader);
        return { status: 413 };
      }
      chunks.push(value);
    }
    const value = decodeSubmissionBody(chunks);
    return value === null ? { status: 400 } : { value };
  } catch {
    cancelBody(reader);
    return { status: stopped === "timeout" ? 408 : 400 };
  } finally {
    clearTimeout(timer);
    if (onAbort) request.signal.removeEventListener("abort", onAbort);
  }
}

export async function POST(request: Request): Promise<Response> {
  let endpoint: ReturnType<typeof configuredFlagEndpoint>;
  try {
    endpoint = configuredFlagEndpoint();
  } catch {
    console.error("Flag route configuration is invalid.");
    return respond(503);
  }
  const url = new URL(request.url);
  if (url.search) return respond(404);
  const authority = request.headers.get("host");
  if (url.protocol !== "https:" || authority !== endpoint.hostname) return respond(400);
  const parsed = parseSubmissionRequest(request.headers);
  if ("status" in parsed) return respond(parsed.status);
  const body = await readBody(request);
  if ("status" in body) return respond(body.status);
  try {
    const result = await receiveFlagSubmission({ ...parsed, value: body.value });
    return respond({ accepted: 202, conflict: 409, unauthorized: 401, stale: 409 }[result]);
  } catch {
    console.error("Flag route storage failure", parsed.gameId);
    return respond(500);
  }
}

function rejectMethod(): Response {
  return respond(405);
}

export const GET = rejectMethod;
export const HEAD = rejectMethod;
export const PUT = rejectMethod;
export const PATCH = rejectMethod;
export const DELETE = rejectMethod;
export const OPTIONS = rejectMethod;
