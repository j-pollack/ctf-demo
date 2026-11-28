import assert from "node:assert/strict";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  assignmentOff,
  decide,
  moveDomain,
  MoveFailed,
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

type Call = { method: string; url: URL; headers: Headers; body: string | undefined };
type Reply = number | Error | object;

// A fetch that answers from a queue of replies per route and fails on anything unexpected. A route
// is "METHOD /path" or just "/path" for any method, and may be a function of the request.
function stub(routes: Record<string, Reply[] | ((call: Call) => Reply)>) {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : undefined;
    const call = { method, url, headers: new Headers(init?.headers), body };
    calls.push(call);
    const route = routes[`${method} ${url.pathname}`] ?? routes[url.pathname];
    if (!route) throw new Error(`unexpected request ${method} ${url.pathname}`);
    let next: Reply;
    if (typeof route === "function") next = route(call);
    else {
      if (!route.length) throw new Error(`unexpected request ${method} ${url.pathname}`);
      next = route.length > 1 ? (route.shift() as Reply) : route[0];
    }
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

test("nothing ready within eight minutes throws", async () => {
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

test("the alias read is tried once more after a 5xx, a 429 or no answer, and never after a 404", async () => {
  for (const first of [503, 429, new Error("socket hang up")]) {
    const { api, calls } = stub({
      "/v4/aliases/h": [first, { alias: "h", deploymentId: "dpl_a" }],
    });
    assert.equal(await servingDeploymentId("h", api, 0), "dpl_a");
    assert.equal(calls.length, 2);
  }
  const down = stub({ "/v4/aliases/h": [503] });
  await assert.rejects(servingDeploymentId("h", down.api, 0), /503/);
  assert.equal(down.calls.length, 2);
  const gone = stub({ "/v4/aliases/h": [404] });
  await assert.rejects(servingDeploymentId("h", gone.api, 0), /404/);
  assert.equal(gone.calls.length, 1);
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
  handler: (path: string, auth: string, method: string) => [number, unknown],
  options: { cwd?: string; headSha?: string; env?: Record<string, string> } = {},
) {
  const seen: string[] = [];
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const auth = request.headers.authorization ?? "";
    seen.push(auth);
    const path = new URL(request.url ?? "/", "http://x").pathname;
    requests.push(`${request.method} ${path}`);
    const [status, body] = handler(path, auth, request.method ?? "GET");
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
      ...options.env,
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
    requests,
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
    if (path === "/v9/projects/prj_1") return [200, { autoAssignCustomDomains: false }];
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

// The promote, rollback and setting commands.
const ALIAS_PATH = "/v4/aliases/ctf.example.com";
const ALIAS = `GET ${ALIAS_PATH}`;
const serving = (id: string) => ({ alias: "ctf.example.com", deploymentId: id });
const move = (direction: "promote" | "rollback", api: Api, c = clock()) =>
  moveDomain(direction, "ctf.example.com", "dpl_new", api, c);
const PATHS = {
  promote: "POST /v10/projects/prj_1/promote/dpl_new",
  rollback: "POST /v9/projects/prj_1/rollback/dpl_new",
};
const posts = (calls: Call[]) => calls.filter((call) => call.method === "POST");

test("promote sends one POST with the token, the team, JSON and an empty object, then polls the alias", async () => {
  const { api, calls } = stub({
    [PATHS.promote]: [201],
    [ALIAS]: [serving("dpl_old"), serving("dpl_old"), serving("dpl_new")],
  });
  const c = clock();
  const result = await move("promote", api, c);
  assert.deepEqual(result, { servingId: "dpl_new", moved: true });
  const sent = posts(calls);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url.pathname, "/v10/projects/prj_1/promote/dpl_new");
  assert.equal(sent[0].url.searchParams.get("teamId"), "team_1");
  assert.equal(sent[0].headers.get("authorization"), `Bearer ${TOKEN}`);
  assert.equal(sent[0].headers.get("content-type"), "application/json");
  assert.equal(sent[0].body, "{}");
  assert.equal(c.slept, 6_000);
});

test("promote passes on a 409 when the alias already serves the deployment", async () => {
  const { api, calls } = stub({ [PATHS.promote]: [409], [ALIAS]: [serving("dpl_new")] });
  assert.equal((await move("promote", api)).servingId, "dpl_new");
  assert.equal(posts(calls).length, 1);
});

test("promote fails after the two minute deadline on 409, 429, 500 or no answer, naming both", async () => {
  for (const reply of [409, 429, 500, new TypeError("fetch failed")]) {
    const { api, calls } = stub({ [PATHS.promote]: [reply], [ALIAS]: [serving("dpl_old")] });
    const c = clock();
    const start = c.now();
    const status = reply instanceof Error ? "no answer" : String(reply);
    await assert.rejects(move("promote", api, c), (error: Error) => {
      assert.ok(error instanceof MoveFailed);
      assert.match(error.message, new RegExp(`${status}.*|.*${status}`));
      assert.match(error.message, /dpl_old/);
      assert.equal(error.servingId, "dpl_old");
      return true;
    });
    assert.equal(posts(calls).length, 1);
    const waited = c.now() - start;
    assert.ok(waited >= 120_000 && waited < 125_000, `waited ${waited}`);
  }
});

test("a poll survives an alias read that fails and still sends one POST", async () => {
  const { api, calls } = stub({
    [PATHS.promote]: [201],
    [ALIAS]: [503, new TypeError("fetch failed"), serving("dpl_new")],
  });
  assert.equal((await move("promote", api)).servingId, "dpl_new");
  assert.equal(posts(calls).length, 1);
});

test("promote answered 202 fails at once naming a rolling release", async () => {
  const { api, calls } = stub({ [PATHS.promote]: [202] });
  const c = clock();
  await assert.rejects(move("promote", api, c), /202.*rolling release.*later/s);
  assert.equal(calls.length, 1);
  assert.equal(c.slept, 0);
});

test("promote answered 400, 401, 403, 404 or 422 fails after one read of the alias", async () => {
  for (const status of [400, 401, 403, 404, 422]) {
    const { api, calls } = stub({ [PATHS.promote]: [status], [ALIAS]: [serving("dpl_old")] });
    const c = clock();
    await assert.rejects(move("promote", api, c), new RegExp(`${status}.*dpl_old`, "s"));
    assert.equal(calls.length, 2);
    assert.equal(posts(calls).length, 1);
    assert.equal(c.slept, 0);
  }
});

test("a malformed id sends no request", async () => {
  const bad = ["dpl_x/../y", "dpl x", "", "a".repeat(65)];
  for (const id of bad) {
    const { api, calls } = stub({});
    await assert.rejects(moveDomain("promote", "h", id, api, clock()), /malformed/);
    assert.equal(calls.length, 0);
  }
  for (const patch of [{ projectId: "prj/1" }, { teamId: "team 1" }]) {
    const { api, calls } = stub({});
    await assert.rejects(move("promote", { ...api, ...patch }), /malformed/);
    assert.equal(calls.length, 0);
  }
});

test("rollback to the deployment that already serves sends nothing", async () => {
  const { api, calls } = stub({ [ALIAS]: [serving("dpl_new")] });
  assert.deepEqual(await move("rollback", api), { servingId: "dpl_new", moved: false });
  assert.equal(posts(calls).length, 0);
});

test("rollback from another deployment follows the rules of promote on the rollback path", async () => {
  const ok = stub({
    [PATHS.rollback]: [201],
    [ALIAS]: [serving("dpl_bad"), serving("dpl_bad"), serving("dpl_new")],
  });
  assert.deepEqual(await move("rollback", ok.api), { servingId: "dpl_new", moved: true });
  assert.equal(posts(ok.calls).length, 1);
  assert.equal(posts(ok.calls)[0].body, "{}");
  assert.equal(posts(ok.calls)[0].headers.get("content-type"), "application/json");
  const queued = stub({ [PATHS.rollback]: [202], [ALIAS]: [serving("dpl_bad")] });
  await assert.rejects(move("rollback", queued.api), /rolling release/);
  const refused = stub({ [PATHS.rollback]: [403], [ALIAS]: [serving("dpl_bad")] });
  await assert.rejects(move("rollback", refused.api), /403.*dpl_bad/s);
  assert.equal(refused.calls.length, 3);
  const stuck = stub({ [PATHS.rollback]: [500], [ALIAS]: [serving("dpl_bad")] });
  const c = clock();
  await assert.rejects(move("rollback", stuck.api, c), (error: Error) => {
    assert.match(error.message, /500/);
    assert.match(error.message, /dpl_bad/);
    return true;
  });
  assert.equal(posts(stuck.calls).length, 1);
  assert.ok(c.slept >= 120_000);
});

test("rollback sends its POST when the first alias read fails even after its retry", async () => {
  const { api, calls } = stub({
    [PATHS.rollback]: [201],
    [ALIAS]: [503, 503, serving("dpl_bad"), serving("dpl_new")],
  });
  const result = await moveDomain("rollback", "ctf.example.com", "dpl_new", api, clock(), 0);
  assert.deepEqual(result, { servingId: "dpl_new", moved: true });
  assert.equal(posts(calls).length, 1);
  assert.equal(posts(calls)[0].url.pathname, "/v9/projects/prj_1/rollback/dpl_new");
});

// The project record with the alias job. Without rollbackInfo=true Vercel returns no job.
function project(reads: { setting: boolean; job?: string | null; to?: string }[]) {
  const sent: { rollbackInfo: string | null }[] = [];
  let index = 0;
  const read = (call: Call): Reply => {
    sent.push({ rollbackInfo: call.url.searchParams.get("rollbackInfo") });
    const step = reads[Math.min(index++, reads.length - 1)];
    const wants = call.url.searchParams.get("rollbackInfo") === "true";
    return {
      autoAssignCustomDomains: step.setting,
      lastAliasRequest:
        wants && step.job
          ? { toDeploymentId: step.to ?? "dpl_new", jobStatus: step.job, type: "promote" }
          : null,
    };
  };
  return { read, sent };
}
const PATCH = "PATCH /v9/projects/prj_1";
const off = (api: Api, c = clock(), warnings: string[] = []) =>
  assignmentOff("dpl_new", api, c, (message) => warnings.push(message));
const patches = (calls: Call[]) => calls.filter((call) => call.method === "PATCH");

test("assignment-off patches once, reads false and passes without a warning", async () => {
  const p = project([{ setting: false, job: "succeeded" }]);
  const { api, calls } = stub({ "GET /v9/projects/prj_1": p.read, [PATCH]: [{}] });
  const warnings: string[] = [];
  await off(api, clock(), warnings);
  const sent = patches(calls);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body, '{"autoAssignCustomDomains":false}');
  assert.equal(sent[0].headers.get("content-type"), "application/json");
  assert.equal(sent[0].headers.get("authorization"), `Bearer ${TOKEN}`);
  assert.equal(sent[0].url.searchParams.get("teamId"), "team_1");
  assert.deepEqual(warnings, []);
  assert.ok(p.sent.length >= 2 && p.sent.every((read) => read.rollbackInfo === "true"));
});

test("assignment-off warns when the setting read true, patches and passes once it reads false", async () => {
  const p = project([
    { setting: true, job: "succeeded" },
    { setting: false, job: "succeeded" },
  ]);
  const { api, calls } = stub({ "GET /v9/projects/prj_1": p.read, [PATCH]: [{}] });
  const warnings: string[] = [];
  await off(api, clock(), warnings);
  assert.equal(warnings.length, 1);
  assert.equal(patches(calls).length, 1);
});

test("assignment-off waits for the job of this deployment to be final", async () => {
  const p = project([
    { setting: false, job: "pending" },
    { setting: false, job: "in-progress" },
    { setting: false, job: "succeeded", to: "dpl_other" },
    { setting: false, job: "failed" },
  ]);
  const { api, calls } = stub({ "GET /v9/projects/prj_1": p.read, [PATCH]: [{}] });
  const c = clock();
  await off(api, c);
  assert.equal(c.slept, 9_000);
  assert.equal(patches(calls).length, 1);
});

test("assignment-off patches and then fails when the job is never final within a minute", async () => {
  const p = project([{ setting: false, job: "in-progress" }]);
  const { api, calls } = stub({ "GET /v9/projects/prj_1": p.read, [PATCH]: [{}] });
  const c = clock();
  const start = c.now();
  await assert.rejects(off(api, c), /not final within 1 minute.*could still turn on.*by hand/s);
  assert.equal(patches(calls).length, 1);
  assert.ok(c.now() - start >= 60_000 && c.now() - start < 65_000);
});

test("assignment-off tries a patch that answers 500 once more, and gives up after three", async () => {
  const p = project([{ setting: false, job: "succeeded" }]);
  const once = stub({ "GET /v9/projects/prj_1": p.read, [PATCH]: [500, {}] });
  const onceClock = clock();
  await off(once.api, onceClock);
  assert.equal(patches(once.calls).length, 2);
  assert.equal(onceClock.slept, 3_000);
  const thrice = stub({ "GET /v9/projects/prj_1": p.read, [PATCH]: [500] });
  const thriceClock = clock();
  await assert.rejects(off(thrice.api, thriceClock), /dpl_new.*500/s);
  assert.equal(patches(thrice.calls).length, 3);
  assert.equal(thriceClock.slept, 6_000);
});

test("assignment-off does not repeat a refused patch, and says the domain serves the deployment", async () => {
  const p = project([{ setting: true, job: "succeeded" }]);
  const { api, calls } = stub({ "GET /v9/projects/prj_1": p.read, [PATCH]: [403] });
  await assert.rejects(off(api), /domain serves deployment dpl_new.*403/s);
  assert.equal(patches(calls).length, 1);
});

test("assignment-off fails when the last read is true or cannot be made", async () => {
  const stays = project([{ setting: true, job: "succeeded" }]);
  const a = stub({ "GET /v9/projects/prj_1": stays.read, [PATCH]: [{}] });
  await assert.rejects(off(a.api), /domain serves deployment dpl_new.*reads true/s);
  const first = project([{ setting: false, job: "succeeded" }]);
  let reads = 0;
  const b = stub({
    "GET /v9/projects/prj_1": (call) => (reads++ ? new Error("fetch failed") : first.read(call)),
    [PATCH]: [{}],
  });
  await assert.rejects(off(b.api), /domain serves deployment dpl_new.*read back/s);
});

test("assignment-off sends nothing for a malformed id", async () => {
  const { api, calls } = stub({});
  await assert.rejects(
    assignmentOff("../x", api, clock(), () => {}),
    /malformed/,
  );
  assert.equal(calls.length, 0);
});

// The same commands as the workflow runs them, against a loopback server.
const SETTING_BODY = (setting: boolean) => ({
  autoAssignCustomDomains: setting,
  lastAliasRequest: { toDeploymentId: "dpl_new", jobStatus: "succeeded", type: "promote" },
});

test("the commands print the serving id and never the token", async () => {
  let patched = false;
  const handler = (path: string, _auth: string, method: string): [number, unknown] => {
    if (path === "/v10/projects/prj_1/promote/dpl_new") return [201, {}];
    if (path === "/v9/projects/prj_1/rollback/dpl_new") return [201, {}];
    if (path === ALIAS_PATH) return [200, { deploymentId: "dpl_new" }];
    if (path === "/v9/projects/prj_1") {
      patched ||= method === "PATCH";
      return [200, SETTING_BODY(!patched)];
    }
    return [404, {}];
  };
  for (const [args, pattern] of [
    [["promote", "dpl_new"], /^serving_id=dpl_new$/m],
    [["rollback", "dpl_new"], /^moved=false$/m],
    [["assignment-off", "dpl_new"], /Automatic assignment is off/],
  ] as const) {
    const result = await runScript([...args], handler);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, pattern);
    for (const text of [result.stdout, result.stderr, result.output, result.summary])
      assert.doesNotMatch(text, new RegExp(TOKEN));
  }
});

test("a rollback that moves the domain prints moved=true", async () => {
  let rolledBack = false;
  const result = await runScript(["rollback", "dpl_new"], (path, _auth, method) => {
    if (method === "POST" && path === "/v9/projects/prj_1/rollback/dpl_new") {
      rolledBack = true;
      return [201, {}];
    }
    if (path === ALIAS_PATH) return [200, { deploymentId: rolledBack ? "dpl_new" : "dpl_bad" }];
    return [404, {}];
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^moved=true$/m);
  assert.match(result.stdout, /^serving_id=dpl_new$/m);
  assert.doesNotMatch(result.stdout, new RegExp(TOKEN));
});

test("a failed promote prints the serving id and not the token, and a bad id sends nothing", async () => {
  const failed = await runScript(["promote", "dpl_new"], (path) =>
    path === ALIAS_PATH ? [200, { deploymentId: "dpl_old" }] : [403, { error: "forbidden" }],
  );
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /^serving_id=dpl_old$/m);
  assert.match(failed.stderr, /403.*dpl_old/s);
  for (const text of [failed.stdout, failed.stderr]) assert.doesNotMatch(text, new RegExp(TOKEN));
  const bad = await runScript(["promote", "dpl_x y"], () => [200, {}]);
  assert.equal(bad.status, 1);
  assert.deepEqual(bad.requests, []);
  const badProject = await runScript(["promote", "dpl_new"], () => [200, {}], {
    env: { VERCEL_PROJECT_ID: "prj/../x" },
  });
  assert.equal(badProject.status, 1);
  assert.deepEqual(badProject.requests, []);
});

// A6.
test("lookup on already-serving fails when automatic assignment is on, passes with a warning when off, and fails when unreadable", async () => {
  const run = (projectReply: [number, unknown]) =>
    runScript(["lookup"], (path) => {
      if (path === "/v6/deployments") return [200, listBody([item("dpl_new", "READY", 5)])];
      if (path === ALIAS_PATH) return [200, { deploymentId: "dpl_new" }];
      if (path === "/v9/projects/prj_1") return projectReply;
      return [404, {}];
    });
  const on = await run([200, { autoAssignCustomDomains: true }]);
  assert.equal(on.status, 1);
  assert.match(
    on.stderr,
    /automatic assignment is on.*not checked by this run.*autoAssignCustomDomains/s,
  );
  assert.match(on.output, /^decision=already-serving$/m);
  const quiet = await run([200, { autoAssignCustomDomains: false }]);
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.match(quiet.stdout, /::warning::/);
  for (const reply of [
    [403, {}],
    [200, {}],
  ] as [number, unknown][]) {
    const unreadable = await run(reply);
    assert.equal(unreadable.status, 1);
    assert.match(unreadable.stderr, /setting/);
  }
});
