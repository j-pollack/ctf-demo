# Fly monitor worker deployment

Worktree: `/Users/jonathan/Code/ctf/.worktrees/persistent-run-sessions`
Branch: `feature/persistent-run-sessions`

Status: implemented, not deployed. Fly apps, secrets and CI credentials are set up (2026-11-12). The first production and preview deploys happen after merge.

## Goal

Async runs need `scripts/monitor-worker.ts` running continuously against the same database as the
app. Vercel cannot host a long-running loop. Production and every Vercel preview get a worker on
Fly.io, deployed by GitHub Actions in step with the existing pipeline.

## Current pipeline

- `ci.yml`: check, integration tests and build on every PR and push to `main`.
- `migrate-prod.yml`: after `ci` succeeds on a push to `main`, migrates production at that commit.
- Vercel Git integration: production from `main`, gated on the `ci` and `migrate prod` checks. Each
  preview migrates its own Neon branch in `scripts/vercel-build.ts` before building.

## Design

### Image

One `Dockerfile` for production and previews: Node 24, `npm ci`, the repository source and
`seed/workspace.tar.gz` (read when scoring). The command is
`node --import tsx scripts/monitor-worker.ts`. `.dockerignore` excludes `.env*`, `node_modules`,
`.next`, `coverage`, `.worktrees` and `.git`.

### Production

- Fly app `ctf-monitor-worker`, region `sea` (nearest to Neon `us-west-2`). One machine, no HTTP
  service, restart always.
- `fly.toml` sets `kill_signal = "SIGTERM"` and a kill timeout. The worker already stops on
  SIGTERM, and an interrupted review's claim expires after 90 seconds for another worker to take.
- Secrets are set once by hand: `DATABASE_URL_UNPOOLED`, `OPENROUTER_API_KEY`, `SPRITE_TOKEN`,
  `TYPESAFE_API_KEY`. Implementation confirms the worker reads nothing else at startup.
- A `deploy worker` job in `migrate-prod.yml`, after the migrate job, checks out the same
  `workflow_run.head_sha` and runs `flyctl deploy`. A separate workflow chained on `migrate prod`
  would see main's latest head instead, which may not be migrated yet.
- Add `deploy worker` to Vercel's production alias checks, so new app code goes live only after
  the matching worker is running.

### Previews

- One shared Fly app `ctf-monitor-worker-preview` holding the API keys, set once by hand. Each PR
  gets one machine in it, tagged with metadata `pr=<number>`.
- Trigger: GitHub `deployment_status` with state `success` and environment `Preview`, posted by
  Vercel after the preview build, which has already migrated the preview's Neon branch. The
  deployment carries only a commit, so the workflow finds the branch whose head it is and skips
  stale commits. Machines are keyed by Git branch, matching Neon's `preview/<git branch>` names.
- CI looks up that preview's Neon branch connection URL through the Neon API, masks it in the
  log, builds and pushes the image tagged with the commit, replaces the PR's machine, and passes
  the URL as the machine's `DATABASE_URL_UNPOOLED`.
- Cleanup: on branch `delete` or `pull_request` `closed`, destroy that branch's machines. Preview machines
  restart on failure with a retry limit, so a machine whose branch was deleted stops instead of
  crash-looping.

## Changes

- `Dockerfile`, `.dockerignore`, `fly.toml`. Preview machine settings are flags in the workflow.
- `.github/workflows/migrate-prod.yml` (new `deploy worker` job), `.github/workflows/preview-worker.yml`.
- README deployment section: the worker's place in the pipeline, one-time setup, rollback.
- Remove the README note that the worker must be run as a separate process by hand.

## One-time setup

Done: both Fly apps in the `personal` org with staged secrets, separate OpenRouter, Typesafe,
Resend and Sprite keys per environment in Vercel and dev `.env.local`, GitHub secrets
`FLY_API_TOKEN_PROD`, `FLY_API_TOKEN_PREVIEW` and `NEON_API_KEY`, and variable `NEON_PROJECT_ID`.

Remaining for the user: add `deploy worker` to Vercel's production alias checks, and revoke the
old provider keys after the first deploys on the new ones.

## Verification

- Image built locally and run against a disposable TLS Postgres migrated by `scripts/setup.ts`:
  started with only the four variables, held one connection, used about 190 MiB idle, and exited
  0 within a second of SIGTERM.
- `actionlint` and `fly config validate` pass. Every flyctl flag used was checked against the
  installed flyctl. The Neon branch search and `connection_uri` calls were run read-only against
  `preview/feature/persistent-run-sessions`.
- Not exercised: the workflows on GitHub, Fly remote builds, machine metadata matching, and live
  reviews from Fly. The first production and preview deploys after merge are the live check.

## Rollback

`flyctl releases` and `flyctl deploy --image <previous>` roll the worker back on its own. App
rollback via Vercel Instant Rollback keeps the README's existing rule: old binaries cannot resume
async runs.

## Resolved questions

- Neon preview branches are named `preview/<git branch>`, created by Vercel from `production`.
- Each environment has its own provider keys.
