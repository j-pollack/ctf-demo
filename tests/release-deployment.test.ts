import assert from "node:assert/strict";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  decide,
  gitIsAncestor,
  deploymentCommit,
  findDeployment,
  servingDeploymentId,
  type Api,
  type Clock,
} from "../scripts/release-deployment";

// Git hooks export GIT_DIR and GIT_INDEX_FILE. Left in place, every git command below would act
// on this repository instead of the temporary one it names.
for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) delete process.env[key];

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(ROOT, "scripts/release-deployment.ts");
const TOKEN = "vcp_test_token_do_not_print_0123456789";

type Item = { uid: string; url: string; state: string; created: number; sha: string };
const item = (uid: string, state: string, created: number, sha = SHA): Item => ({
  uid,
  url: `ctf-${uid.replaceAll("_", "-")}.vercel.app`,
  state,
  created,
  sha,
});
const listBody = (items: Item[]) => ({
  deployments: items.map(({ sha, ...rest }) => ({ ...rest, meta: { githubCommitSha: sha } })),
});

// A fetch that answers from a queue of replies per path and fails on anything unexpected.
function stub(routes: Record<string, unknown[]>) {
  const calls: { url: URL; headers: Headers }[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, headers: new Headers(init?.headers) });
    const queue = routes[url.pathname];
    if (!queue?.length) throw new Error(`unexpected request ${url.pathname}`);
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    if (typeof next === "number") return new Response("{}", { status: next });
    return Response.json(next);
  }) as typeof fetch;
  const api: Api = {
    token: TOKEN,
    teamId: "team_1",
    projectId: "prj_1",
    fetchFn,
    base: "https://vercel.test",
  };
  return { api, calls };
}
function clock(): Clock & { slept: number } {
  let t = 1_000_000;
  const c = {
    slept: 0,
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
      c.slept += ms;
    },
  };
  return c;
}

test("the lookup judges only the newest deployment for the commit", async () => {
  const { api, calls } = stub({
    "/v6/deployments": [
      listBody([
        item("old", "ERROR", 100),
        item("new", "READY", 300),
        item("mid", "CANCELED", 200),
        item("elsewhere", "ERROR", 900, OTHER),
      ]),
    ],
  });
  const found = await findDeployment(SHA, api, clock());
  assert.deepEqual(found, { id: "new", url: "https://ctf-new.vercel.app", created: 300 });
  const { url, headers } = calls[0];
  assert.equal(url.searchParams.get("target"), "production");
  assert.equal(url.searchParams.get("projectId"), "prj_1");
  assert.equal(url.searchParams.get("teamId"), "team_1");
  assert.match(url.searchParams.get("limit") ?? "", /^\d+$/);
  assert.equal(headers.get("authorization"), `Bearer ${TOKEN}`);
});

test("a deployment still building is polled again until it is ready", async () => {
  const { api, calls } = stub({
    "/v6/deployments": [
      listBody([item("d1", "QUEUED", 100)]),
      listBody([item("d1", "BUILDING", 100)]),
      listBody([item("d1", "READY", 100)]),
    ],
  });
  const c = clock();
  assert.equal((await findDeployment(SHA, api, c)).id, "d1");
  assert.equal(calls.length, 3);
  assert.ok(c.slept > 0);
});

test("a commit with no deployment yet is polled again", async () => {
  const { api } = stub({
    "/v6/deployments": [
      listBody([item("x", "READY", 5, OTHER)]),
      listBody([item("d1", "READY", 9)]),
    ],
  });
  assert.equal((await findDeployment(SHA, api, clock())).id, "d1");
});

test("an ERROR or CANCELED newest deployment throws naming the state", async () => {
  for (const state of ["ERROR", "CANCELED"]) {
    const { api } = stub({
      "/v6/deployments": [listBody([item("ok", "READY", 100), item("bad", state, 200)])],
    });
    await assert.rejects(findDeployment(SHA, api, clock()), new RegExp(`bad.*${state}`));
  }
});

test("nothing ready within ten minutes throws", async () => {
  const { api } = stub({ "/v6/deployments": [listBody([item("d1", "BUILDING", 100)])] });
  const c = clock();
  const start = c.now();
  await assert.rejects(findDeployment(SHA, api, c), /not ready within 8 minutes/);
  const waited = c.now() - start;
  assert.ok(waited >= 480_000 && waited < 540_000, `waited ${waited}`);
});

test("an API error status throws without the token", async () => {
  const { api } = stub({ "/v6/deployments": [403] });
  await assert.rejects(findDeployment(SHA, api, clock()), (error: Error) => {
    assert.match(error.message, /403/);
    assert.doesNotMatch(error.message, new RegExp(TOKEN));
    return true;
  });
});

test("the serving deployment comes from the alias, then its commit from the deployment by id", async () => {
  const { api, calls } = stub({
    "/v4/aliases/ctf.example.com": [{ alias: "ctf.example.com", deploymentId: "dpl_old" }],
    "/v13/deployments/dpl_old": [{ id: "dpl_old", meta: { githubCommitSha: OTHER } }],
  });
  assert.equal(await servingDeploymentId("ctf.example.com", api), "dpl_old");
  assert.equal(await deploymentCommit("dpl_old", api), OTHER);
  assert.equal(calls[0].url.searchParams.get("teamId"), "team_1");
  assert.equal(calls[1].url.searchParams.get("teamId"), "team_1");
});

test("a deployment with no commit reads as null, a missing alias target throws", async () => {
  const none = stub({ "/v13/deployments/d": [{ id: "d", meta: {} }] });
  assert.equal(await deploymentCommit("d", none.api), null);
  const bad = stub({ "/v4/aliases/h": [{ alias: "h" }] });
  await assert.rejects(servingDeploymentId("h", bad.api), /deploymentId/);
  const gone = stub({ "/v13/deployments/d": [404] });
  await assert.rejects(deploymentCommit("d", gone.api), /404/);
});

test("the decision follows the ids and the ancestry", () => {
  assert.equal(decide("n", "n", true), "already-serving");
  assert.equal(decide("n", "n", null), "already-serving");
  assert.equal(decide("n", "s", true), "promote");
  assert.equal(decide("n", "s", false), "refuse");
  assert.equal(decide("n", "s", null), "refuse");
  assert.equal(decide("n", null, null), "refuse");
  assert.equal(decide("n", null, true), "refuse");
});

// The script entry talks to a loopback server through RELEASE_API_URL, which the workflow never sets.
async function runScript(
  args: string[],
  handler: (path: string, auth: string) => [number, unknown],
  options: { cwd?: string; headSha?: string } = {},
) {
  const seen: string[] = [];
  const server = createServer((request, response) => {
    const auth = request.headers.authorization ?? "";
    seen.push(auth);
    const [status, body] = handler(new URL(request.url ?? "/", "http://x").pathname, auth);
    // Echoes the credential back, so printing a response body would leak it.
    response.writeHead(status, { "content-type": "application/json", "x-echo": auth });
    response.end(JSON.stringify({ echo: auth, ...(body as object) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const dir = mkdtempSync(join(tmpdir(), "release-"));
  const output = join(dir, "output");
  const summary = join(dir, "summary");
  writeFileSync(output, "");
  writeFileSync(summary, "");
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), SCRIPT, ...args], {
    cwd: options.cwd ?? ROOT,
    env: {
      PATH: process.env.PATH ?? "",
      NODE_ENV: "test",
      VERCEL_TOKEN: TOKEN,
      VERCEL_ORG_ID: "team_1",
      VERCEL_PROJECT_ID: "prj_1",
      PRODUCTION_ORIGIN: "https://ctf.example.com",
      HEAD_SHA: options.headSha ?? SHA,
      RELEASE_API_URL: `http://127.0.0.1:${port}`,
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: summary,
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
  server.close();
  return {
    status,
    stdout,
    stderr,
    seen,
    output: readFileSync(output, "utf8"),
    summary: readFileSync(summary, "utf8"),
  };
}

test("the script never prints the token when the API fails", async () => {
  const result = await runScript(["lookup"], () => [403, { error: "forbidden" }]);
  assert.notEqual(result.status, 0);
  assert.ok(result.seen.includes(`Bearer ${TOKEN}`), "the stub never saw the token");
  for (const text of [result.stdout, result.stderr, result.output, result.summary])
    assert.doesNotMatch(text, new RegExp(TOKEN));
  assert.match(result.stderr, /403/);
});

test("the script never prints the token on success, and writes the decision", async () => {
  const result = await runScript(["lookup"], (path) => {
    if (path === "/v6/deployments") return [200, listBody([item("dpl_new", "READY", 5)])];
    if (path === "/v4/aliases/ctf.example.com") return [200, { deploymentId: "dpl_new" }];
    return [404, {}];
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.seen.includes(`Bearer ${TOKEN}`));
  for (const text of [result.stdout, result.stderr, result.output, result.summary])
    assert.doesNotMatch(text, new RegExp(TOKEN));
  assert.match(result.output, /^decision=already-serving$/m);
  assert.match(result.output, /^new_id=dpl_new$/m);
  assert.match(result.output, /^new_url=https:\/\/ctf-dpl-new\.vercel\.app$/m);
  assert.match(result.output, /^serving_id=dpl_new$/m);
  assert.match(result.stdout, /::warning::/);
  assert.match(result.summary, /already-serving/);
});

test("a refusal fails the script naming both deployments", async () => {
  const result = await runScript(["lookup"], (path) => {
    if (path === "/v6/deployments") return [200, listBody([item("dpl_new", "READY", 5)])];
    if (path === "/v4/aliases/ctf.example.com") return [200, { deploymentId: "dpl_serving" }];
    return [404, {}];
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /dpl_new/);
  assert.match(result.stderr, /dpl_serving/);
  assert.match(result.output, /^decision=refuse$/m);
});

test("verify passes only when the domain serves the expected deployment", async () => {
  const handler = (path: string): [number, unknown] =>
    path === "/v4/aliases/ctf.example.com" ? [200, { deploymentId: "dpl_new" }] : [404, {}];
  assert.equal((await runScript(["verify", "dpl_new"], handler)).status, 0);
  const wrong = await runScript(["verify", "dpl_other"], handler);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /dpl_new/);
  assert.match(wrong.stdout, /^serving_id=dpl_new$/m);
  assert.match((await runScript(["verify", "dpl_new"], handler)).stdout, /^serving_id=dpl_new$/m);
});

test("a missing environment variable fails naming it", async () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/release-deployment.ts", "lookup"],
    {
      cwd: new URL("..", import.meta.url),
      env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /VERCEL_TOKEN/);
});

function repoWithCommits(count: number) {
  const dir = mkdtempSync(join(tmpdir(), "release-git-"));
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-C",
        dir,
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        ...args,
      ],
      { encoding: "utf8" },
    ).trim();
  git("init", "-q");
  const shas = Array.from({ length: count }, (_, index) => {
    git("commit", "-q", "--allow-empty", "-m", `c${index}`);
    return git("rev-parse", "HEAD");
  });
  return { dir, shas };
}

test("ancestry: equal and ancestor are true, a descendant is false, an unknown commit throws", () => {
  const { dir, shas } = repoWithCommits(2);
  const [first, second] = shas;
  assert.equal(gitIsAncestor(first, second, dir), true);
  assert.equal(gitIsAncestor(second, second, dir), true);
  assert.equal(gitIsAncestor(second, first, dir), false);
  assert.throws(() => gitIsAncestor("c".repeat(40), second, dir), /git merge-base failed/);
  assert.throws(() => gitIsAncestor("--all", second, dir), /40 hex/);
});

// The lookup entry in a real repository, so the order of the ancestry arguments matters.
async function lookupWith(servingIndex: number) {
  const { dir, shas } = repoWithCommits(3);
  const headSha = shas[1];
  return runScript(
    ["lookup"],
    (path) => {
      if (path === "/v6/deployments")
        return [200, listBody([item("dpl_new", "READY", 5, headSha)])];
      if (path === "/v4/aliases/ctf.example.com") return [200, { deploymentId: "dpl_serving" }];
      if (path === "/v13/deployments/dpl_serving")
        return [200, { meta: { githubCommitSha: shas[servingIndex] } }];
      return [404, {}];
    },
    { cwd: dir, headSha },
  );
}

test("lookup: a serving commit that is an ancestor of the new commit promotes", async () => {
  const result = await lookupWith(0);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.output, /^decision=promote$/m);
  assert.match(result.output, /^serving_id=dpl_serving$/m);
});

test("lookup: a serving commit that is a descendant of the new commit is refused", async () => {
  const result = await lookupWith(2);
  assert.equal(result.status, 1);
  assert.match(result.output, /^decision=refuse$/m);
});

test("lookup: the same commit under a different deployment id promotes", async () => {
  const result = await lookupWith(1);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.output, /^decision=promote$/m);
});

test("lookup: malformed API values never reach the outputs", async () => {
  const result = await runScript(["lookup"], (path) => {
    if (path === "/v6/deployments") return [200, listBody([item("dpl_new", "READY", 5)])];
    if (path === "/v4/aliases/ctf.example.com")
      return [200, { deploymentId: "dpl_x\ndecision=promote" }];
    return [404, {}];
  });
  assert.equal(result.status, 1);
  assert.equal(result.output.match(/^decision=/gm)?.length, 1);
  assert.match(result.output, /^decision=refuse$/m);
  assert.match(result.output, /^serving_id=$/m);
  assert.doesNotMatch(result.summary, /decision=promote/);
});

// N5 and N6 at function level.
test("a malformed deployment entry is ignored by the lookup", async () => {
  const bad = (patch: object) => ({
    ...listBody([item("dpl_bad", "READY", 900)]).deployments[0],
    ...patch,
  });
  const entries = [
    bad({ uid: "dpl_x\nnew_id=1" }),
    bad({ url: "evil.example\nnew_url=x" }),
    bad({ created: "900" }),
    bad({ created: Number.NaN }),
    ...listBody([item("dpl_good", "READY", 100)]).deployments,
  ];
  const { api } = stub({ "/v6/deployments": [{ deployments: entries }] });
  assert.equal((await findDeployment(SHA, api, clock())).id, "dpl_good");
});

test("a malformed serving id or commit is unreadable", async () => {
  const badId = stub({ "/v4/aliases/h": [{ deploymentId: "dpl_x\ny" }] });
  await assert.rejects(servingDeploymentId("h", badId.api), /deploymentId/);
  const badSha = stub({ "/v13/deployments/d": [{ meta: { githubCommitSha: "HEAD" } }] });
  assert.equal(await deploymentCommit("d", badSha.api), null);
});

test("the lookup retries a 429, a 5xx and a network error on the next poll", async () => {
  for (const transient of [429, 503, new TypeError("fetch failed")]) {
    const { api, calls } = stub({
      "/v6/deployments": [transient, listBody([item("dpl_1", "READY", 1)])],
    });
    assert.equal((await findDeployment(SHA, api, clock())).id, "dpl_1");
    assert.equal(calls.length, 2);
  }
});

test("the lookup fails at once on 401, 403 and 404", async () => {
  for (const status of [401, 403, 404]) {
    const { api, calls } = stub({
      "/v6/deployments": [status, listBody([item("dpl_1", "READY", 1)])],
    });
    await assert.rejects(findDeployment(SHA, api, clock()), new RegExp(`${status}`));
    assert.equal(calls.length, 1);
  }
});

test("a lookup that only ever sees 503 times out and says why", async () => {
  const { api } = stub({ "/v6/deployments": [503] });
  await assert.rejects(findDeployment(SHA, api, clock()), /not ready within 8 minutes.*503/);
});
