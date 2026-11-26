import assert from "node:assert/strict";
import { test } from "node:test";
import { releaseMismatches, type Mode } from "../scripts/release-check";

const BASE = "https://ctf-abc123.vercel.app";
const PAGES: Record<string, string> = {
  "/": "Capture the flag without getting caught",
  "/rules": "If a word is new to you, there is a glossary at the bottom.",
  "/rank": "VERIFIED WINS",
  "/contact": "Questions, ideas or problems with the game? Write to us.",
  "/signin": "Email me a link",
};

type Seen = { method: string; url: string; init: RequestInit | undefined };
type Reply = { status: number; type?: string; body?: string };
type One = Reply | "fail" | "hang";
type Replies = Record<string, One | One[]>;

const good = (mode: Mode): Replies => ({
  ...Object.fromEntries(
    Object.entries(PAGES).map(([path, marker]) => [
      `GET ${path}`,
      { status: 200, type: "text/html; charset=utf-8", body: `<html><h1>${marker}</h1></html>` },
    ]),
  ),
  "GET /api/leaderboard": { status: 200, type: "application/json", body: '{"entries":[]}' },
  "GET /v1/end": { status: 405, type: "text/plain", body: "" },
  "POST /v1/end": { status: mode === "live" ? 401 : 400, type: "text/plain", body: "" },
});

function stub(replies: Replies) {
  const seen: Seen[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    seen.push({ method: init?.method ?? "GET", url: String(input), init });
    const entry = replies[key];
    const reply = Array.isArray(entry) ? (entry.length > 1 ? entry.shift() : entry[0]) : entry;
    if (!reply) throw new Error(`unexpected request ${key}`);
    if (reply === "fail") throw new TypeError("fetch failed");
    if (reply === "hang")
      return new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      );
    return new Response(reply.body ?? "", {
      status: reply.status,
      headers: reply.type ? { "content-type": reply.type } : {},
    });
  }) as typeof fetch;
  return { fetchFn, seen };
}

for (const mode of ["deployment", "live"] as const)
  test(`${mode}: responses that match the table give no mismatch`, async () => {
    const { fetchFn } = stub(good(mode));
    assert.deepEqual(await releaseMismatches(BASE, mode, fetchFn), []);
  });

test("a wrong status names the request with expected and actual", async () => {
  const { fetchFn } = stub({ ...good("live"), "GET /rules": { status: 500, type: "text/html" } });
  const found = await releaseMismatches(BASE, "live", fetchFn);
  assert.equal(found.length, 1);
  assert.equal(found[0].request, "GET /rules");
  assert.match(found[0].expected, /200/);
  assert.match(found[0].actual, /500/);
});

test("a page without its marker, or not html, is a mismatch", async () => {
  const { fetchFn } = stub({
    ...good("live"),
    "GET /rank": { status: 200, type: "text/html", body: "<html>another page</html>" },
    "GET /contact": { status: 200, type: "application/json", body: PAGES["/contact"] },
  });
  const found = await releaseMismatches(BASE, "live", fetchFn);
  assert.deepEqual(found.map((m) => m.request).sort(), ["GET /contact", "GET /rank"]);
});

test("the leaderboard needs JSON with an entries array", async () => {
  for (const reply of [
    { status: 200, type: "application/json", body: "{}" },
    { status: 200, type: "application/json", body: "not json" },
    { status: 200, type: "application/json", body: '{"entries":"x"}' },
    { status: 503, type: "application/json", body: '{"entries":[]}' },
  ]) {
    const { fetchFn } = stub({ ...good("live"), "GET /api/leaderboard": reply });
    const found = await releaseMismatches(BASE, "live", fetchFn);
    assert.deepEqual(
      found.map((m) => m.request),
      ["GET /api/leaderboard"],
      JSON.stringify(reply),
    );
  }
});

test("GET /v1/end must answer 405", async () => {
  const { fetchFn } = stub({ ...good("live"), "GET /v1/end": { status: 200 } });
  const found = await releaseMismatches(BASE, "live", fetchFn);
  assert.deepEqual(
    found.map((m) => m.request),
    ["GET /v1/end"],
  );
});

test("a connection failure and a timeout are mismatches, not throws", async () => {
  const { fetchFn } = stub({ ...good("live"), "GET /": "fail", "GET /signin": "hang" });
  const found = await releaseMismatches(BASE, "live", fetchFn, 20);
  assert.deepEqual(found.map((m) => m.request).sort(), ["GET /", "GET /signin"]);
  for (const mismatch of found) assert.notEqual(mismatch.actual, "");
});

test("POST /v1/end: 401 fails on a deployment URL and 400 fails on the live origin", async () => {
  const replies = (status: number): Replies => ({ ...good("live"), "POST /v1/end": { status } });
  assert.deepEqual(
    (await releaseMismatches(BASE, "deployment", stub(replies(401)).fetchFn)).map((m) => m.request),
    ["POST /v1/end"],
  );
  assert.deepEqual(await releaseMismatches(BASE, "live", stub(replies(401)).fetchFn), []);
  assert.deepEqual(
    (await releaseMismatches(BASE, "live", stub(replies(400)).fetchFn)).map((m) => m.request),
    ["POST /v1/end"],
  );
  assert.deepEqual(await releaseMismatches(BASE, "deployment", stub(replies(400)).fetchFn), []);
});

test("requests carry no Origin, query string, credentials or body, and follow no redirect", async () => {
  const { fetchFn, seen } = stub(good("deployment"));
  await releaseMismatches(BASE, "deployment", fetchFn);
  assert.equal(seen.length, 8);
  for (const { url, init } of seen) {
    assert.equal(new URL(url).search, "");
    assert.equal(new URL(url).origin, BASE);
    assert.equal(init?.redirect, "manual");
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.body, undefined);
    assert.equal(new Headers(init?.headers).get("origin"), null);
    assert.equal(new Headers(init?.headers).get("authorization"), null);
    assert.equal(new Headers(init?.headers).get("cookie"), null);
  }
});

test("a redirect is a mismatch", async () => {
  const { fetchFn } = stub({ ...good("live"), "GET /": { status: 307 } });
  const found = await releaseMismatches(BASE, "live", fetchFn);
  assert.deepEqual(
    found.map((m) => m.request),
    ["GET /"],
  );
});

test("each request is logged with its status", async () => {
  const lines: string[] = [];
  const { fetchFn } = stub({ ...good("live"), "GET /": "fail" });
  await releaseMismatches(BASE, "live", fetchFn, 1000, (line) => lines.push(line));
  assert.equal(lines.length, 8);
  assert.ok(lines.some((line) => line.includes("GET /rules") && line.includes("200")));
  assert.ok(lines.some((line) => line.includes("POST /v1/end") && line.includes("401")));
});

test("a request that fails to connect is tried once more before it is a mismatch", async () => {
  const { fetchFn, seen } = stub({
    ...good("live"),
    "GET /": ["fail", { status: 200, type: "text/html", body: PAGES["/"] }],
  });
  assert.deepEqual(await releaseMismatches(BASE, "live", fetchFn), []);
  assert.equal(seen.filter((call) => call.url.endsWith("/")).length, 2);
});

test("a request that keeps failing or timing out is a mismatch after two tries", async () => {
  const { fetchFn, seen } = stub({ ...good("live"), "GET /": ["fail"], "GET /rank": ["hang"] });
  const found = await releaseMismatches(BASE, "live", fetchFn, 20);
  assert.deepEqual(found.map((m) => m.request).sort(), ["GET /", "GET /rank"]);
  assert.equal(seen.filter((call) => call.url === `${BASE}/`).length, 2);
  assert.equal(seen.filter((call) => call.url.endsWith("/rank")).length, 2);
});

test("a response with the wrong status is never retried", async () => {
  const { fetchFn, seen } = stub({ ...good("live"), "GET /rules": [{ status: 500 }] });
  await releaseMismatches(BASE, "live", fetchFn);
  assert.equal(seen.filter((call) => call.url.endsWith("/rules")).length, 1);
});
