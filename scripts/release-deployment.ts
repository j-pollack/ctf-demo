import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

// Reads and moves Vercel's state for a release. The token comes from the environment only and is
// sent only in the Authorization header. Nothing here prints a response body or the token.
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
const ALIAS_RETRY_MS = 2_000;
const MOVE_TIMEOUT_MS = 2 * 60_000;
const MOVE_POLL_MS = 3_000;
const SETTING_TIMEOUT_MS = 60_000;
const SETTING_REQUEST_MS = 15_000;
const SETTING_TRIES = 3;
const FINAL_JOB_STATUSES = new Set(["succeeded", "failed", "skipped"]);
// The one path not yet observed against the live project: a single deployment by id.
const DEPLOYMENT_PATH = (id: string) => `/v13/deployments/${encodeURIComponent(id)}`;
const LIST_PATH = "/v6/deployments";
const ALIAS_PATH = (host: string) => `/v4/aliases/${encodeURIComponent(host)}`;
const PROJECT_PATH = (id: string) => `/v9/projects/${encodeURIComponent(id)}`;
// Promote and rollback are the paths the Vercel CLI sends. Both answer before the move finishes.
const MOVE_PATHS = {
  promote: (project: string, id: string) =>
    `/v10/projects/${encodeURIComponent(project)}/promote/${encodeURIComponent(id)}`,
  rollback: (project: string, id: string) =>
    `/v9/projects/${encodeURIComponent(project)}/rollback/${encodeURIComponent(id)}`,
};

// What comes from the API is checked before it is used or written to a workflow output. A
// value that fails is treated as that deployment being unreadable.
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const HOST_PATTERN = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
export const SHA_PATTERN = /^[0-9a-f]{40}$/;

export class ApiError extends Error {
  constructor(
    method: string,
    readonly path: string,
    readonly status: number,
  ) {
    super(`Vercel API ${method} ${path} returned ${status}`);
  }
}

// A move that did not finish. `servingId` is the deployment the domain served at the last read.
export class MoveFailed extends Error {
  constructor(
    message: string,
    readonly servingId: string | null,
  ) {
    super(message);
  }
}

// A 429, a 5xx or a failure to get any answer may pass by the next poll. Other statuses will not.
export const isTransient = (error: unknown) =>
  !(error instanceof ApiError) || error.status === 429 || error.status >= 500;

type Listed = {
  uid: string;
  url: string;
  state: string;
  created: number;
  meta?: { githubCommitSha?: string };
};

// Every id that reaches a URL is checked first, so a bad value sends nothing.
function assertIds(...ids: string[]) {
  if (!ids.every((id) => ID_PATTERN.test(id)))
    throw new Error("A project, team or deployment id is malformed.");
}

export async function call(
  api: Api,
  method: "GET" | "POST" | "PATCH",
  path: string,
  params: Record<string, string>,
  body?: object,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  assertIds(api.teamId, api.projectId);
  const url = new URL(path, api.base);
  for (const [key, value] of Object.entries({ teamId: api.teamId, ...params }))
    url.searchParams.set(key, value);
  const response = await api.fetchFn(url, {
    method,
    headers: {
      authorization: `Bearer ${api.token}`,
      ...(body && { "content-type": "application/json" }),
    },
    ...(body && { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new ApiError(method, path, response.status);
  return response;
}

export async function get(
  api: Api,
  path: string,
  params: Record<string, string>,
): Promise<unknown> {
  return (await call(api, "GET", path, params)).json();
}

// Waits for the newest production deployment of the commit, by creation time. Older
// deployments of the same commit and deployments of other commits are ignored.
export const isReadable = (deployment: Listed) =>
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

function aliasDeploymentId(host: string, alias: { deploymentId?: string }): string {
  const id = alias.deploymentId;
  if (typeof id !== "string" || !ID_PATTERN.test(id))
    throw new Error(`Alias ${host} has no valid deploymentId.`);
  return id;
}

export const readAlias = async (host: string, api: Api) =>
  aliasDeploymentId(host, (await get(api, ALIAS_PATH(host), {})) as object);

// One more try after a failure that may pass: the lookup and the rollback's first read each
// decide on a single answer, and one bad answer must not decide wrongly.
export async function servingDeploymentId(
  host: string,
  api: Api,
  retryMs = ALIAS_RETRY_MS,
): Promise<string> {
  const read = () => get(api, ALIAS_PATH(host), {});
  const alias = (await read().catch(async (error: unknown) => {
    if (!isTransient(error)) throw error;
    await sleep(retryMs);
    return read();
  })) as { deploymentId?: string };
  return aliasDeploymentId(host, alias);
}

export async function deploymentCommit(id: string, api: Api): Promise<string | null> {
  const deployment = (await get(api, DEPLOYMENT_PATH(id), {})) as {
    meta?: { githubCommitSha?: string };
  };
  const sha = deployment.meta?.githubCommitSha;
  return typeof sha === "string" && SHA_PATTERN.test(sha) ? sha : null;
}

export type Direction = keyof typeof MOVE_PATHS;
export type Moved = { servingId: string; moved: boolean };

// The status the request answered, or null when it got no answer. It is sent once and never repeated.
async function post(api: Api, path: string): Promise<number | null> {
  try {
    return (await call(api, "POST", path, {}, {})).status;
  } catch (error) {
    return error instanceof ApiError ? error.status : null;
  }
}

// The domain may already serve the deployment, or the move may still be running.
const mayStillMove = (status: number | null) =>
  status === null || status === 409 || status === 429 || status >= 500 || status < 300;

async function pollAlias(
  direction: Direction,
  host: string,
  id: string,
  status: number | null,
  api: Api,
  clock: Clock,
): Promise<string> {
  const deadline = clock.now() + MOVE_TIMEOUT_MS;
  let serving: string | null = null;
  for (;;) {
    serving = await readAlias(host, api).catch(() => serving);
    if (serving === id) return serving;
    if (clock.now() >= deadline)
      throw new MoveFailed(
        `${host} serves deployment ${serving ?? "unknown"}, expected ${id}, 2 minutes after the ${direction} request returned ${status ?? "no answer"}.`,
        serving,
      );
    await clock.sleep(MOVE_POLL_MS);
  }
}

// Moves the production domain to a deployment and passes only when the alias serves it. A rollback
// to the deployment that already serves sends nothing.
export async function moveDomain(
  direction: Direction,
  host: string,
  id: string,
  api: Api,
  clock: Clock,
  retryMs = ALIAS_RETRY_MS,
): Promise<Moved> {
  assertIds(api.teamId, api.projectId, id);
  if (direction === "rollback") {
    // An unreadable alias is unknown: the POST goes out, because a broken release must not stay live.
    const servingId = await servingDeploymentId(host, api, retryMs).catch(() => null);
    if (servingId === id) return { servingId, moved: false };
  }
  const status = await post(api, MOVE_PATHS[direction](api.projectId, id));
  if (status === 202)
    throw new MoveFailed(
      `The ${direction} request returned 202: Vercel queued it behind a rolling release, which this project does not use. It may still perform the ${direction} later without this job's checks.`,
      null,
    );
  if (!mayStillMove(status)) {
    const serving = await readAlias(host, api).catch(() => null);
    throw new MoveFailed(
      `The ${direction} request returned ${status}. ${host} serves deployment ${serving ?? "unknown"}, expected ${id}.`,
      serving,
    );
  }
  return { servingId: await pollAlias(direction, host, id, status, api, clock), moved: true };
}

type Project = { setting: boolean | null; jobFinalFor: (id: string) => boolean };

// `rollbackInfo=true` is what makes Vercel return the last alias job.
async function readProject(api: Api): Promise<Project> {
  const body = (await (
    await call(
      api,
      "GET",
      PROJECT_PATH(api.projectId),
      { rollbackInfo: "true" },
      undefined,
      SETTING_REQUEST_MS,
    )
  ).json()) as {
    autoAssignCustomDomains?: unknown;
    lastAliasRequest?: { toDeploymentId?: unknown; jobStatus?: unknown } | null;
  };
  const job = body.lastAliasRequest;
  return {
    setting:
      typeof body.autoAssignCustomDomains === "boolean" ? body.autoAssignCustomDomains : null,
    jobFinalFor: (id) =>
      job?.toDeploymentId === id &&
      typeof job.jobStatus === "string" &&
      FINAL_JOB_STATUSES.has(job.jobStatus),
  };
}

const TURN_OFF_BY_HAND =
  'Turn off Auto-assign Custom Production Domains in the project settings, or send PATCH /v9/projects/<project id> with {"autoAssignCustomDomains":false}.';

// The setting is read only once Vercel's job for the promotion is final, because the alias can move
// before the job ends.
async function waitForJob(id: string, api: Api, clock: Clock) {
  const deadline = clock.now() + SETTING_TIMEOUT_MS;
  let setting: boolean | null = null;
  for (;;) {
    const project = await readProject(api).catch(() => null);
    if (project) setting = project.setting;
    if (project?.jobFinalFor(id)) return { final: true, setting };
    if (clock.now() >= deadline) return { final: false, setting };
    await clock.sleep(MOVE_POLL_MS);
  }
}

// Tried again only after a failure that may pass.
async function patchSettingOff(api: Api, clock: Clock) {
  for (let attempt = 1; ; attempt++) {
    try {
      await call(
        api,
        "PATCH",
        PROJECT_PATH(api.projectId),
        {},
        { autoAssignCustomDomains: false },
        SETTING_REQUEST_MS,
      );
      return;
    } catch (error) {
      if (!isTransient(error) || attempt >= SETTING_TRIES) throw error;
      await clock.sleep(MOVE_POLL_MS);
    }
  }
}

// Runs after a promotion: Vercel can turn automatic assignment back on, and the setting is
// turned off on every promotion whatever it read.
export async function assignmentOff(
  id: string,
  api: Api,
  clock: Clock,
  warn: (message: string) => void,
): Promise<void> {
  assertIds(api.teamId, api.projectId, id);
  const live = `The production domain serves deployment ${id}`;
  const job = await waitForJob(id, api, clock);
  if (job.setting === true)
    warn(`Automatic assignment was on after the promotion of ${id}. Turning it off.`);
  try {
    await patchSettingOff(api, clock);
  } catch (error) {
    throw new Error(
      `${live}, but turning off automatic assignment failed: ${error instanceof Error ? error.message : String(error)}. ${TURN_OFF_BY_HAND}`,
    );
  }
  const after = await readProject(api).catch((error: unknown) => {
    throw new Error(
      `${live}, but the setting could not be read back: ${error instanceof Error ? error.message : String(error)}. ${TURN_OFF_BY_HAND}`,
    );
  });
  if (after.setting !== false)
    throw new Error(
      `${live}, but automatic assignment still reads ${after.setting}. ${TURN_OFF_BY_HAND}`,
    );
  if (!job.final)
    throw new Error(
      `${live}, but Vercel's job for it was not final within 1 minute. The setting could still turn on when the job ends. Read autoAssignCustomDomains by hand once the job has ended.`,
    );
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

export const realClock: Clock = {
  now: Date.now,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export function readEnv(names: string[]) {
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(", ")}.`);
  return Object.fromEntries(names.map((name) => [name, process.env[name] as string]));
}

export function apiFromEnv(env: Record<string, string>): Api {
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

export function append(file: string | undefined, text: string) {
  if (file) appendFileSync(file, text);
}

// With automatic assignment on, Vercel promoted the deployment itself and nothing here checked it.
async function warnOrFailOnSetting(id: string, host: string, api: Api) {
  const { setting } = await readProject(api).catch((error: unknown) => {
    throw new Error(
      `Deployment ${id} already serves ${host}, and the automatic assignment setting could not be read: ${error instanceof Error ? error.message : String(error)}.`,
    );
  });
  if (setting !== false)
    throw new Error(
      `Deployment ${id} already serves ${host}, but automatic assignment ${setting === true ? "is on" : "could not be read"}, so Vercel may have promoted it and the live site was not checked by this run. ${TURN_OFF_BY_HAND} Then re-run the failed jobs.`,
    );
  console.log(
    `::warning::Deployment ${id} already serves ${host}. An earlier attempt or a promotion by hand put it there.`,
  );
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
  if (decision === "already-serving") await warnOrFailOnSetting(found.id, host, api);
  if (decision === "refuse")
    throw new Error(
      `Refusing to promote deployment ${found.id} (commit ${env.HEAD_SHA}) over ${servingId ?? "an unreadable serving deployment"}: ` +
        "the serving commit is not an ancestor of the new one, or could not be read.",
    );
}

async function move(direction: Direction, id: string | undefined) {
  const env = readEnv(ENV_NAMES);
  const host = new URL(env.PRODUCTION_ORIGIN).host;
  try {
    const result = await moveDomain(direction, host, id ?? "", apiFromEnv(env), realClock);
    // The workflow reads these lines.
    console.log(`serving_id=${result.servingId}`);
    if (direction === "rollback") console.log(`moved=${result.moved}`);
    console.log(
      result.moved
        ? `${host} serves deployment ${result.servingId}.`
        : `${host} already served deployment ${result.servingId}. Nothing had moved.`,
    );
  } catch (error) {
    if (error instanceof MoveFailed && error.servingId)
      console.log(`serving_id=${error.servingId}`);
    throw error;
  }
}

async function setting(id: string | undefined) {
  const env = readEnv(["VERCEL_TOKEN", "VERCEL_ORG_ID", "VERCEL_PROJECT_ID"]);
  await assignmentOff(id ?? "", apiFromEnv(env), realClock, (message) =>
    console.log(`::warning::${message}`),
  );
  console.log("Automatic assignment is off.");
}

if (import.meta.main) {
  const [command, argument] = process.argv.slice(2);
  try {
    if (command === "lookup") await lookup();
    else if (command === "promote" || command === "rollback") await move(command, argument);
    else if (command === "assignment-off") await setting(argument);
    else
      throw new Error(
        "Usage: release-deployment.ts <lookup|promote <id>|rollback <id>|assignment-off <id>>",
      );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
