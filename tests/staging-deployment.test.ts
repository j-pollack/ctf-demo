import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Clock } from "../scripts/release-deployment";
import { ensureStagingDeployment, type StagingRequest } from "../scripts/staging-deployment";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const HOST = "ctf-demo-git-staging-team.vercel.app";
const TOKEN = "vcp_test_token_do_not_print_0123456789";
const REQUEST: StagingRequest = {
  sha: SHA,
  projectName: "ctf-demo",
  repoId: 123456,
  branchHost: HOST,
};

type Item = {
  uid: string;
  url: string;
  state: string;
  created: number;
  ref?: string;
  sha?: string;
  target?: string | null;
};
const item = (uid: string, state: string, created: number, extra: Partial<Item> = {}): Item => ({
  uid,
  url: `ctf-${uid.replaceAll("_", "-")}.vercel.app`,
  state,
  created,
  ref: "staging",
  sha: SHA,
  target: null,
  ...extra,
});
const shape = ({ ref, sha, ...rest }: Item) => ({
  ...rest,
  meta: { githubCommitRef: ref, githubCommitSha: sha },
});

type Call = { method: string; url: URL; body: string | undefined };

// A fake Vercel that keeps the minimal state a scenario needs: what the listing shows on each
// read, what the alias serves on each read, and how a creation request is answered. Anything else
// fails the test.
function fake(plan: {
  lists: Item[][];
  aliases?: string[];
  aliasStatus?: number;
  create?: () => number | Error | Item;
  onCreate?: () => void;
}) {
  const calls: Call[] = [];
  let lists = 0;
  let aliases = 0;
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: typeof init?.body === "string" ? init.body : undefined });
    if (method === "GET" && url.pathname === "/v7/deployments") {
      const next = plan.lists[Math.min(lists++, plan.lists.length - 1)];
      return Response.json({ deployments: next.map(shape) });
    }
    if (method === "POST" && url.pathname === "/v13/deployments") {
      plan.onCreate?.();
      const answer = plan.create?.() ?? 200;
      if (answer instanceof Error) throw answer;
      if (typeof answer === "number") return new Response("{}", { status: answer });
      return Response.json({ id: answer.uid });
    }
    if (method === "GET" && url.pathname === `/v4/aliases/${HOST}`) {
      if (plan.aliasStatus) return new Response("{}", { status: plan.aliasStatus });
      const list = plan.aliases ?? [];
      const id = list[Math.min(aliases++, list.length - 1)];
      if (!id) return new Response("{}", { status: 404 });
      return Response.json({ deploymentId: id });
    }
    throw new Error(`unexpected request ${method} ${url.pathname}`);
  }) as typeof fetch;
  const api: Api = {
    token: TOKEN,
    teamId: "team_1",
    projectId: "prj_1",
    fetchFn,
    base: "https://vercel.test",
  };
  return { api, calls, posts: () => calls.filter((call) => call.method === "POST") };
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

test("with no deployment of the ref and commit, one is created and then waited for", async () => {
  const ready = item("dpl_new", "READY", 500);
  let created = false;
  const stub = fake({
    lists: [[]],
    aliases: ["dpl_new"],
    onCreate: () => {
      created = true;
    },
  });
  const listed = stub.api.fetchFn;
  stub.api.fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (created && url.pathname === "/v7/deployments")
      return Response.json({ deployments: [shape(ready)] });
    return listed(input, init);
  }) as typeof fetch;
  const result = await ensureStagingDeployment(REQUEST, stub.api, clock());
  assert.deepEqual(result, { id: "dpl_new", url: "https://ctf-dpl-new.vercel.app", created: true });
  const [post] = stub.posts();
  assert.equal(stub.posts().length, 1);
  assert.equal(post.url.searchParams.get("teamId"), "team_1");
  assert.deepEqual(JSON.parse(post.body ?? ""), {
    name: "ctf-demo",
    project: "prj_1",
    gitSource: { type: "github", repoId: 123456, ref: "staging", sha: SHA },
  });
  const list = stub.calls[0].url;
  assert.equal(list.searchParams.get("branch"), "staging");
  assert.equal(list.searchParams.get("sha"), SHA);
  assert.equal(list.searchParams.get("projectId"), "prj_1");
});

test("an existing deployment is waited for and none is created", async () => {
  const stub = fake({
    lists: [
      [item("dpl_a", "QUEUED", 100)],
      [item("dpl_a", "BUILDING", 100)],
      [item("dpl_a", "READY", 100)],
    ],
    aliases: ["dpl_a"],
  });
  const result = await ensureStagingDeployment(REQUEST, stub.api, clock());
  assert.deepEqual(result, { id: "dpl_a", url: "https://ctf-dpl-a.vercel.app", created: false });
  assert.equal(stub.posts().length, 0);
});

test("a first build that is cancelled is pending until a newer one becomes ready", async () => {
  const stub = fake({
    lists: [
      [],
      [item("dpl_1", "CANCELED", 100)],
      [item("dpl_1", "CANCELED", 100)],
      [item("dpl_1", "CANCELED", 100), item("dpl_2", "BUILDING", 106)],
      [item("dpl_1", "CANCELED", 100), item("dpl_2", "READY", 106)],
    ],
    aliases: ["dpl_2"],
  });
  const result = await ensureStagingDeployment(REQUEST, stub.api, clock());
  assert.equal(result.id, "dpl_2");
  assert.equal(stub.posts().length, 1);
});

test("a cancelled newest deployment that nothing replaces fails at the deadline", async () => {
  const stub = fake({ lists: [[], [item("dpl_1", "CANCELED", 100)]], aliases: ["dpl_1"] });
  const c = clock();
  await assert.rejects(
    ensureStagingDeployment(REQUEST, stub.api, c),
    /not ready within 10 minutes.*CANCELED/s,
  );
  assert.ok(c.slept >= 10 * 60_000);
  assert.equal(stub.posts().length, 1);
});

test("a deployment that ends in ERROR fails at once", async () => {
  const stub = fake({
    lists: [[item("dpl_1", "BUILDING", 100)], [item("dpl_1", "ERROR", 100)]],
  });
  const c = clock();
  await assert.rejects(ensureStagingDeployment(REQUEST, stub.api, c), /dpl_1.*ERROR/);
  assert.ok(c.slept < 60_000);
});

test("a ready deployment waits until the branch address serves it", async () => {
  const stub = fake({
    lists: [[item("dpl_new", "READY", 100)]],
    aliases: ["dpl_previous_commit", "dpl_previous_commit", "dpl_new"],
  });
  const c = clock();
  const result = await ensureStagingDeployment(REQUEST, stub.api, c);
  assert.equal(result.id, "dpl_new");
  assert.ok(c.slept > 0);
  assert.equal(stub.posts().length, 0);
});

test("an address that never serves the deployment fails at the deadline", async () => {
  const stub = fake({ lists: [[item("dpl_new", "READY", 100)]], aliases: ["dpl_other"] });
  await assert.rejects(
    ensureStagingDeployment(REQUEST, stub.api, clock()),
    /not ready within 10 minutes/,
  );
});

test("a creation request with no answer is followed by a listing and never repeated", async () => {
  let created = false;
  const stub = fake({
    lists: [[]],
    aliases: ["dpl_new"],
    create: () => {
      created = true;
      return new Error("socket hang up");
    },
  });
  const listed = stub.api.fetchFn;
  stub.api.fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (created && url.pathname === "/v7/deployments")
      return Response.json({ deployments: [shape(item("dpl_new", "READY", 100))] });
    return listed(input, init);
  }) as typeof fetch;
  const result = await ensureStagingDeployment(REQUEST, stub.api, clock());
  assert.equal(result.id, "dpl_new");
  assert.equal(stub.posts().length, 1);
});

test("a request with no answer that never shows a deployment still sends only one", async () => {
  const stub = fake({ lists: [[]], create: () => new Error("socket hang up") });
  await assert.rejects(
    ensureStagingDeployment(REQUEST, stub.api, clock()),
    /not ready within 10 minutes/,
  );
  assert.equal(stub.posts().length, 1);
});

test("a refused creation fails with its status", async () => {
  const stub = fake({ lists: [[]], create: () => 403 });
  await assert.rejects(ensureStagingDeployment(REQUEST, stub.api, clock()), /403/);
  assert.equal(stub.posts().length, 1);
});

test("the commit's production deployment is not the staging deployment", async () => {
  const production = item("dpl_prod", "READY", 100, { ref: "main", target: "production" });
  const stub = fake({
    lists: [[production]],
    aliases: ["dpl_prod"],
    create: () => 403,
  });
  await assert.rejects(ensureStagingDeployment(REQUEST, stub.api, clock()), /403/);
  assert.equal(stub.posts().length, 1);
});

test("another branch's preview of the same commit is not the staging deployment", async () => {
  const preview = item("dpl_other", "READY", 100, { ref: "feature/x" });
  const stub = fake({ lists: [[preview]], create: () => 403 });
  await assert.rejects(ensureStagingDeployment(REQUEST, stub.api, clock()), /403/);
  assert.equal(stub.posts().length, 1);
});

test("a deployment of the staging ref at another commit is ignored", async () => {
  const stub = fake({ lists: [[item("dpl_x", "READY", 100, { sha: OTHER })]], create: () => 403 });
  await assert.rejects(ensureStagingDeployment(REQUEST, stub.api, clock()), /403/);
});

test("an existing deployment of the ref is found even when its target is staging or null", async () => {
  const stub = fake({
    lists: [[item("dpl_s", "READY", 100, { target: "staging" })]],
    aliases: ["dpl_s"],
  });
  assert.equal((await ensureStagingDeployment(REQUEST, stub.api, clock())).id, "dpl_s");
  assert.equal(stub.posts().length, 0);
});

test("a malformed request sends nothing", async () => {
  const stub = fake({ lists: [[]] });
  await assert.rejects(
    ensureStagingDeployment({ ...REQUEST, sha: "abc" }, stub.api, clock()),
    /40 hex/,
  );
  await assert.rejects(
    ensureStagingDeployment({ ...REQUEST, repoId: 1.5 }, stub.api, clock()),
    /repository id/,
  );
  assert.equal(stub.calls.length, 0);
});

test("an old ERROR deployment does not fail the command right after it creates a new one", async () => {
  const old = item("dpl_old", "ERROR", 100);
  const stub = fake({
    lists: [[old], [old], [old, item("dpl_new", "READY", 500)]],
    aliases: ["dpl_new"],
  });
  const result = await ensureStagingDeployment(REQUEST, stub.api, clock());
  assert.deepEqual(result, { id: "dpl_new", url: "https://ctf-dpl-new.vercel.app", created: true });
  assert.equal(stub.posts().length, 1);
});

test("a new deployment that also ends in ERROR fails early after an old ERROR", async () => {
  const old = item("dpl_old", "ERROR", 100);
  const stub = fake({ lists: [[old], [old, item("dpl_new", "ERROR", 500)]] });
  const c = clock();
  await assert.rejects(ensureStagingDeployment(REQUEST, stub.api, c), /dpl_new.*ERROR/);
  assert.ok(c.slept < 60_000);
});

test("a permanent refusal reading the address fails at once", async () => {
  const stub = fake({ lists: [[item("dpl_a", "READY", 100)]], aliasStatus: 403 });
  const c = clock();
  await assert.rejects(ensureStagingDeployment(REQUEST, stub.api, c), /403/);
  assert.ok(c.slept < 60_000);
});

test("a transient failure reading the address is polled again", async () => {
  const stub = fake({ lists: [[item("dpl_a", "READY", 100)]], aliasStatus: 503 });
  await assert.rejects(
    ensureStagingDeployment(REQUEST, stub.api, clock()),
    /not ready within 10 minutes/,
  );
});

test("a ready deployment that the address serves is enough while a newer one is CANCELED", async () => {
  const stub = fake({
    lists: [[item("dpl_ready", "READY", 100), item("dpl_cancelled", "CANCELED", 200)]],
    aliases: ["dpl_ready"],
  });
  const result = await ensureStagingDeployment(REQUEST, stub.api, clock());
  assert.equal(result.id, "dpl_ready");
});
