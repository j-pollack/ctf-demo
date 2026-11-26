import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

// Reads Vercel's state for a release. The token comes from the environment only and is sent
// only in the Authorization header. Nothing here prints a response body or the token.
export type Api = {
  token: string;
  teamId: string;
  projectId: string;
  fetchFn: typeof fetch;
  base: string;
};
export type Clock = { now: () => number; sleep: (ms: number) => Promise<void> };
export type Found = { id: string; url: string; created: number };
export type Decision = "promote" | "already-serving" | "refuse";

const LIST_LIMIT = 20;
const POLL_MS = 15_000;
const READY_TIMEOUT_MS = 8 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
// The one path not yet observed against the live project: a single deployment by id.
const DEPLOYMENT_PATH = (id: string) => `/v13/deployments/${encodeURIComponent(id)}`;
const LIST_PATH = "/v6/deployments";
const ALIAS_PATH = (host: string) => `/v4/aliases/${encodeURIComponent(host)}`;

// What comes from the API is checked before it is used or written to a workflow output. A
// value that fails is treated as that deployment being unreadable.
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const HOST_PATTERN = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;

class ApiError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
  ) {
    super(`Vercel API GET ${path} returned ${status}`);
  }
}

// A 429, a 5xx or a failure to get any answer may pass by the next poll. Other statuses will not.
const isTransient = (error: unknown) =>
  !(error instanceof ApiError) || error.status === 429 || error.status >= 500;

type Listed = {
  uid: string;
  url: string;
  state: string;
  created: number;
  meta?: { githubCommitSha?: string };
};

async function get(api: Api, path: string, params: Record<string, string>): Promise<unknown> {
  const url = new URL(path, api.base);
  for (const [key, value] of Object.entries({ teamId: api.teamId, ...params }))
    url.searchParams.set(key, value);
  const response = await api.fetchFn(url, {
    headers: { authorization: `Bearer ${api.token}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new ApiError(path, response.status);
  return response.json();
}

// Waits for the newest production deployment of the commit, by creation time. Older
// deployments of the same commit and deployments of other commits are ignored.
const isReadable = (deployment: Listed) =>
  typeof deployment.uid === "string" &&
  ID_PATTERN.test(deployment.uid) &&
  typeof deployment.url === "string" &&
  HOST_PATTERN.test(deployment.url) &&
  typeof deployment.created === "number" &&
  Number.isFinite(deployment.created);

async function newestFor(sha: string, api: Api): Promise<Listed | undefined> {
  const body = (await get(api, LIST_PATH, {
    projectId: api.projectId,
    target: "production",
    limit: String(LIST_LIMIT),
  })) as { deployments?: Listed[] };
  return (body.deployments ?? [])
    .filter((deployment) => deployment.meta?.githubCommitSha === sha && isReadable(deployment))
    .sort((a, b) => b.created - a.created)[0];
}

export async function findDeployment(sha: string, api: Api, clock: Clock): Promise<Found> {
  const deadline = clock.now() + READY_TIMEOUT_MS;
  let state = "none found";
  for (;;) {
    try {
      const newest = await newestFor(sha, api);
      state = newest ? newest.state : "none found";
      if (newest?.state === "ERROR" || newest?.state === "CANCELED")
        throw new Error(`Deployment ${newest.uid} for commit ${sha} is ${newest.state}.`);
      if (newest?.state === "READY")
        return { id: newest.uid, url: `https://${newest.url}`, created: newest.created };
    } catch (error) {
      if (!isTransient(error) || state === "ERROR" || state === "CANCELED") throw error;
      state = error instanceof Error ? error.message : String(error);
    }
    if (clock.now() >= deadline)
      throw new Error(`Deployment for commit ${sha} not ready within 8 minutes (${state}).`);
    await clock.sleep(POLL_MS);
  }
}

export async function servingDeploymentId(host: string, api: Api): Promise<string> {
  const alias = (await get(api, ALIAS_PATH(host), {})) as { deploymentId?: string };
  const id = alias.deploymentId;
  if (typeof id !== "string" || !ID_PATTERN.test(id))
    throw new Error(`Alias ${host} has no valid deploymentId.`);
  return id;
}

export async function deploymentCommit(id: string, api: Api): Promise<string | null> {
  const deployment = (await get(api, DEPLOYMENT_PATH(id), {})) as {
    meta?: { githubCommitSha?: string };
  };
  const sha = deployment.meta?.githubCommitSha;
  return typeof sha === "string" && SHA_PATTERN.test(sha) ? sha : null;
}

// `servingIsAncestor` is whether the serving commit is the new commit or one of its ancestors,
// or null when it could not be told. Creation time is not used: a redeploy gets a new one.
export function decide(
  newId: string,
  servingId: string | null,
  servingIsAncestor: boolean | null,
): Decision {
  if (servingId === newId) return "already-serving";
  return servingId !== null && servingIsAncestor === true ? "promote" : "refuse";
}

// Exit 0 means ancestor or equal, 1 means not. Any other failure throws.
export function gitIsAncestor(ancestor: string, descendant: string, cwd = process.cwd()): boolean {
  if (!SHA_PATTERN.test(ancestor) || !SHA_PATTERN.test(descendant))
    throw new Error("Commit ids must be 40 hex characters.");
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      stdio: "ignore",
      cwd,
    });
    return true;
  } catch (error) {
    if ((error as { status?: number }).status === 1) return false;
    throw new Error(`git merge-base failed for ${ancestor} and ${descendant}.`);
  }
}

const realClock: Clock = {
  now: Date.now,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

function readEnv(names: string[]) {
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(", ")}.`);
  return Object.fromEntries(names.map((name) => [name, process.env[name] as string]));
}

function apiFromEnv(env: Record<string, string>): Api {
  return {
    token: env.VERCEL_TOKEN,
    teamId: env.VERCEL_ORG_ID,
    projectId: env.VERCEL_PROJECT_ID,
    fetchFn: fetch,
    // Only the offline test sets this, to reach a loopback server. The workflow never does.
    base: process.env.RELEASE_API_URL ?? "https://api.vercel.com",
  };
}

const ENV_NAMES = ["VERCEL_TOKEN", "VERCEL_ORG_ID", "VERCEL_PROJECT_ID", "PRODUCTION_ORIGIN"];

// A failed read leaves the value unknown, which the decision turns into a refusal.
async function orNull<T>(what: string, read: () => Promise<T> | T): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    console.error(`${what}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function append(file: string | undefined, text: string) {
  if (file) appendFileSync(file, text);
}

async function lookup() {
  const env = readEnv([...ENV_NAMES, "HEAD_SHA"]);
  const api = apiFromEnv(env);
  const host = new URL(env.PRODUCTION_ORIGIN).host;
  const found = await findDeployment(env.HEAD_SHA, api, realClock);
  const servingId = await orNull("Could not read the serving deployment", () =>
    servingDeploymentId(host, api),
  );
  const servingCommit =
    servingId && servingId !== found.id
      ? await orNull(`Could not read the commit of deployment ${servingId}`, () =>
          deploymentCommit(servingId, api),
        )
      : null;
  const servingIsAncestor = servingCommit
    ? await orNull("Could not compare commits", () => gitIsAncestor(servingCommit, env.HEAD_SHA))
    : null;
  const decision = decide(found.id, servingId, servingIsAncestor);
  const lines = [
    `new_id=${found.id}`,
    `new_url=${found.url}`,
    `serving_id=${servingId ?? ""}`,
    `decision=${decision}`,
  ];
  append(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  console.log(lines.join("\n"));
  append(
    process.env.GITHUB_STEP_SUMMARY,
    `Release promotion: decision ${decision}, new deployment ${found.id}, serving deployment ${servingId ?? "unknown"}.\n`,
  );
  if (decision === "already-serving")
    console.log(
      `::warning::Deployment ${found.id} already serves ${host}. Vercel promoted it or an earlier attempt did.`,
    );
  if (decision === "refuse")
    throw new Error(
      `Refusing to promote deployment ${found.id} (commit ${env.HEAD_SHA}) over ${servingId ?? "an unreadable serving deployment"}: ` +
        "the serving commit is not an ancestor of the new one, or could not be read.",
    );
}

async function verify(expectedId: string | undefined) {
  if (!expectedId) throw new Error("Usage: release-deployment.ts verify <deployment id>");
  const env = readEnv(ENV_NAMES);
  const host = new URL(env.PRODUCTION_ORIGIN).host;
  const servingId = await servingDeploymentId(host, apiFromEnv(env));
  // The workflow reads this line to name the serving deployment when it is not the expected one.
  console.log(`serving_id=${servingId}`);
  if (servingId !== expectedId)
    throw new Error(`${host} serves deployment ${servingId}, expected ${expectedId}.`);
  console.log(`${host} serves deployment ${servingId}.`);
}

if (import.meta.main) {
  const [command, argument] = process.argv.slice(2);
  try {
    if (command === "lookup") await lookup();
    else if (command === "verify") await verify(argument);
    else throw new Error("Usage: release-deployment.ts <lookup|verify <deployment id>>");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
