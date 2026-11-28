import {
  HOST_PATTERN,
  SHA_PATTERN,
  ApiError,
  append,
  apiFromEnv,
  call,
  get,
  isReadable,
  isTransient,
  readAlias,
  readEnv,
  realClock,
  type Api,
  type Clock,
} from "./release-deployment";

// Makes sure Vercel has a deployment of the git ref `staging` at a commit and waits until the
// branch address serves a ready one. The token is sent only in the Authorization header.
export type StagingRequest = {
  sha: string;
  projectName: string;
  repoId: number;
  branchHost: string;
};
export type Staged = { id: string; url: string; created: boolean };

const REF = "staging";
// The documented version that takes the `branch` and `sha` query parameters.
const LIST_PATH = "/v7/deployments";
const CREATE_PATH = "/v13/deployments";
const LIST_LIMIT = 20;
// A build takes about a minute, and Vercel cancels the first build here and starts another about
// six seconds later, so the poll is shorter than that gap.
const POLL_MS = 5_000;
const TIMEOUT_MS = 10 * 60_000;
const PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;
// A deployment in one of these states is a build that exists or is on its way.
const LIVE_STATES = new Set(["QUEUED", "INITIALIZING", "BUILDING", "READY"]);

type Listed = {
  uid: string;
  url: string;
  state: string;
  created: number;
  meta?: { githubCommitRef?: string; githubCommitSha?: string };
};

// Selected by the git ref and commit in each deployment's own metadata, so a server that ignores
// a query parameter cannot hand back the commit's production build or another branch's preview.
async function listMatching({ sha }: StagingRequest, api: Api): Promise<Listed[]> {
  const body = (await get(api, LIST_PATH, {
    projectId: api.projectId,
    branch: REF,
    sha,
    limit: String(LIST_LIMIT),
  })) as { deployments?: Listed[] };
  return (body.deployments ?? [])
    .filter(
      (deployment) =>
        deployment.meta?.githubCommitRef === REF &&
        deployment.meta.githubCommitSha === sha &&
        isReadable(deployment),
    )
    .sort((a, b) => b.created - a.created);
}

// Creating is not idempotent, so it is sent once. A refusal fails with its status. A request that
// got no answer, or a 5xx that may have created the deployment, is settled by the next listing.
class Failed extends Error {}

async function create(request: StagingRequest, api: Api): Promise<void> {
  try {
    await call(
      api,
      "POST",
      CREATE_PATH,
      {},
      {
        name: request.projectName,
        project: api.projectId,
        gitSource: { type: "github", repoId: request.repoId, ref: REF, sha: request.sha },
      },
    );
  } catch (error) {
    if (error instanceof ApiError && error.status < 500) throw new Failed(error.message);
  }
}

function validate(request: StagingRequest) {
  if (!SHA_PATTERN.test(request.sha)) throw new Error("The commit must be 40 hex characters.");
  if (!Number.isSafeInteger(request.repoId) || request.repoId <= 0)
    throw new Error("The repository id must be a positive integer.");
  if (!PROJECT_NAME_PATTERN.test(request.projectName))
    throw new Error("The project name is malformed.");
  if (!HOST_PATTERN.test(request.branchHost)) throw new Error("The branch address is malformed.");
}

export async function ensureStagingDeployment(
  request: StagingRequest,
  api: Api,
  clock: Clock,
): Promise<Staged> {
  validate(request);
  const deadline = clock.now() + TIMEOUT_MS;
  let state = "none found";
  let created = false;
  let decided = false;
  // Set when this call creates one: only deployments newer than the newest seen before the request
  // are judged, so an old ERROR does not fail the wait for the new build.
  let floor = -Infinity;
  for (;;) {
    try {
      const listed = await listMatching(request, api);
      if (!decided) {
        decided = true;
        if (!listed.some((deployment) => LIVE_STATES.has(deployment.state))) {
          created = true;
          floor = listed[0]?.created ?? -Infinity;
          await create(request, api);
        }
      }
      const matches = listed.filter((deployment) => deployment.created > floor);
      const newest = matches[0];
      state = newest?.state ?? "none found";
      // Any ready deployment of the ref and commit that the address serves is enough, even when a
      // newer one was cancelled.
      const ready = matches.filter((deployment) => deployment.state === "READY");
      if (ready.length) {
        // Only what may pass by the next poll is swallowed. A refusal fails the command.
        const serving = await readAlias(request.branchHost, api).catch((error: unknown) => {
          if (!isTransient(error)) throw error;
          return null;
        });
        const served = ready.find((deployment) => deployment.uid === serving);
        if (served) return { id: served.uid, url: `https://${served.url}`, created };
        state = `READY, ${request.branchHost} serves ${serving ?? "no deployment"}`;
      }
      // A newest CANCELED one stays pending: Vercel starts another seconds later.
      if (newest?.state === "ERROR")
        throw new Failed(`Deployment ${newest.uid} for commit ${request.sha} is ERROR.`);
    } catch (error) {
      if (error instanceof Failed || !isTransient(error)) throw error;
      state = error instanceof Error ? error.message : String(error);
    }
    if (clock.now() >= deadline)
      throw new Error(
        `Deployment for commit ${request.sha} not ready within 10 minutes (${state}).`,
      );
    await clock.sleep(POLL_MS);
  }
}

async function main() {
  const env = readEnv([
    "VERCEL_TOKEN",
    "VERCEL_ORG_ID",
    "VERCEL_PROJECT_ID",
    "STAGING_ORIGIN",
    "STAGING_PROJECT_NAME",
    "REPOSITORY_ID",
    "HEAD_SHA",
  ]);
  const staged = await ensureStagingDeployment(
    {
      sha: env.HEAD_SHA,
      projectName: env.STAGING_PROJECT_NAME,
      repoId: Number(env.REPOSITORY_ID),
      branchHost: new URL(env.STAGING_ORIGIN).host,
    },
    apiFromEnv(env),
    realClock,
  );
  const lines = [
    `deployment_id=${staged.id}`,
    `deployment_url=${staged.url}`,
    `created=${staged.created}`,
  ];
  append(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  console.log(lines.join("\n"));
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
