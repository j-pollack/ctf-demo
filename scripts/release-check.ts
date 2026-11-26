// Read-only HTTP checks for a release. `deployment` runs against a deployment's own URL and
// `live` against the production origin. The two differ only for POST /v1/end: the route
// compares the request host with the production host before it reads the token, so a
// deployment URL answers 400 and the production origin answers 401.
export type Mode = "deployment" | "live";
export type Mismatch = { request: string; expected: string; actual: string };

type Reply = { status: number; type: string; body: string };
type Spec = {
  method: "GET" | "POST";
  path: string;
  expected: (mode: Mode) => string;
  // Returns what was wrong, or null when the reply is as expected.
  problem: (reply: Reply, mode: Mode) => string | null;
};

// Each marker is text that only that page renders in its server HTML.
const PAGES: [path: string, marker: string][] = [
  ["/", "Capture the flag without getting caught"],
  ["/rules", "If a word is new to you, there is a glossary at the bottom."],
  ["/rank", "VERIFIED WINS"],
  ["/contact", "Questions, ideas or problems with the game? Write to us."],
  ["/signin", "Email me a link"],
];

const page = ([path, marker]: [string, string]): Spec => ({
  method: "GET",
  path,
  expected: () => `200 text/html containing "${marker}"`,
  problem: (reply) => {
    if (reply.status !== 200) return `${reply.status}`;
    if (!reply.type.startsWith("text/html")) return `200 ${reply.type || "no content type"}`;
    return reply.body.includes(marker) ? null : "200 text/html without the marker";
  },
});

const leaderboard: Spec = {
  method: "GET",
  path: "/api/leaderboard",
  expected: () => "200 JSON with an entries array",
  problem: (reply) => {
    if (reply.status !== 200) return `${reply.status}`;
    try {
      const body: unknown = JSON.parse(reply.body);
      const entries = (body as { entries?: unknown } | null)?.entries;
      return Array.isArray(entries) ? null : "200 JSON without an entries array";
    } catch {
      return "200 body that is not JSON";
    }
  },
};

const status = (method: "GET" | "POST", expected: (mode: Mode) => number): Spec => ({
  method,
  path: "/v1/end",
  expected: (mode) => `${expected(mode)}`,
  problem: (reply, mode) => (reply.status === expected(mode) ? null : `${reply.status}`),
});

const SPECS: Spec[] = [
  ...PAGES.map(page),
  leaderboard,
  status("GET", () => 405),
  status("POST", (mode) => (mode === "live" ? 401 : 400)),
];

async function send(
  base: string,
  spec: Spec,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<Reply> {
  const response = await fetchFn(new URL(spec.path, base), {
    method: spec.method,
    redirect: "manual",
    credentials: "omit",
    signal: AbortSignal.timeout(timeoutMs),
  });
  return {
    status: response.status,
    type: response.headers.get("content-type") ?? "",
    body: await response.text(),
  };
}

// A failure to get any answer is tried once more. A response with the wrong status is final.
async function sendOnce(base: string, spec: Spec, fetchFn: typeof fetch, timeoutMs: number) {
  try {
    return await send(base, spec, fetchFn, timeoutMs);
  } catch {
    return send(base, spec, fetchFn, timeoutMs);
  }
}

// Never throws on a bad response: a timeout or a connection failure is a mismatch too.
export async function releaseMismatches(
  baseUrl: string,
  mode: Mode,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 10_000,
  log: (line: string) => void = () => {},
): Promise<Mismatch[]> {
  const results = await Promise.all(
    SPECS.map(async (spec) => {
      const request = `${spec.method} ${spec.path}`;
      try {
        const reply = await sendOnce(baseUrl, spec, fetchFn, timeoutMs);
        return { request, line: `${request} ${reply.status}`, actual: spec.problem(reply, mode) };
      } catch (error) {
        const cause = error instanceof Error ? error.message : String(error);
        return { request, line: `${request} failed: ${cause}`, actual: `no response: ${cause}` };
      }
    }),
  );
  const mismatches: Mismatch[] = [];
  results.forEach((result, index) => {
    log(result.line);
    if (result.actual === null) return;
    mismatches.push({
      request: result.request,
      expected: SPECS[index].expected(mode),
      actual: result.actual,
    });
  });
  return mismatches;
}

if (import.meta.main) {
  const [baseUrl, mode] = process.argv.slice(2);
  if (!baseUrl || (mode !== "deployment" && mode !== "live")) {
    console.error("Usage: release-check.ts <base-url> <deployment|live>");
    process.exit(2);
  }
  console.log(`Checking ${baseUrl} in ${mode} mode`);
  const mismatches = await releaseMismatches(baseUrl, mode, fetch, 10_000, console.log);
  for (const { request, expected, actual } of mismatches)
    console.error(`MISMATCH ${request}: expected ${expected}, got ${actual}`);
  if (mismatches.length) process.exit(1);
}
