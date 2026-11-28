# Release gate, part 3: one real run on staging before each release

Worktree `/Users/jonathan/Code/ctf/.worktrees/staging-gate`, branch `feature/staging-gate`, based on `origin/main`. The story in stage C builds on the worker stories of `docs/plans/e2e-gate-worker.md` and starts after they merge.

Parts 1, 2 and 4 of the gate are on `main`: required checks, the faked browser suite in `ci`, and a release workflow that owns the promotion. This part adds the real mode decided on 2026-11-26.

## Problem

The faked suite proves the app's own code against stand-ins. Nothing before a release proves that the deployed app, the deployed worker, a real Sprite, OpenRouter, Resend and the database work together. The existing smoke scripts import `lib/` on the machine that runs them, so they never touch the Vercel functions, the worker image, its registration or the wake call.

## Decisions already made by the owner

From 2026-11-26:

- One suite, two modes, the same journey in both. Faked on pull requests, real on a staging stack.
- The real mode runs after a merge to `main` and before deployment. It never runs on pull request previews.
- It blocks releases after five passing runs in a row.
- Staging has its own data: a copy of production scrubbed once, never refreshed.
- Sign-in uses Resend's test recipient for the real send, and the test creates the sign-in link in the staging database.

From 2026-11-27:

1. Create the Neon branch `preview/staging` from `production` before the git branch exists. The scrub needs its own yes, with the branch and statements shown.
2. Staging's daily spend cap is $2.
3. Staging uses the OpenRouter and Sprites keys that previews already use.
4. A pass is: the run reached a terminal state, it has one flag receipt, and one final review finished with an allow or block verdict. An unknown verdict or a review error fails the attempt. An attempt gets one retry.
5. An urgent release skips the check through a repository variable that names one commit and a reason.
6. An always-on worker machine for staging is accepted.

## Design

### The staging stack

A long-lived git branch `staging`. The existing machinery does the rest without change:

- Vercel builds each push of `staging` as a Preview deployment and migrates its database in the build. The branch address is `https://ctf-demo-git-staging-jonathans-projects-4c8e1b72.vercel.app` and does not change between pushes.
- The Neon integration gives a preview the database branch `preview/<git branch>`, and reuses one that exists.
- `.github/workflows/preview-worker.yml` deploys a worker machine tagged with the branch on the Fly app `ctf-monitor-worker-preview` after each successful Preview deployment. Nothing deletes the `staging` machine, because the branch is never deleted.

Staging's limits are rows in its own `ctf.settings`, which win over the `CTF_` variables for the app and the worker alike: `daily_cap_microdollars` 2000000 and `runs_per_day` 50. The member limit of three runs a day would otherwise stop the fourth release of a day.

### The story

One new story file under `tests/e2e/`, written once and run in both modes:

1. Sign in.
2. Start a run.
3. Send one instruction that tells the agent to run exactly the upload command from `scripts/smoke-contract.ts` and stop.
4. Wait for the run to leave `active` and `finalizing`.
5. Wait for the run's reviews to settle with `waitForReviews` from `tests/e2e/run.ts`, which fails at once on a review with an operational error and waits until no job is left unsettled.
6. Assert the pass from decision 4, from the database:
   - `ctf.games.status` is `caught`, `ended` or `captured`;
   - one row in `ctf.flag_submissions` for the run, with `promoted_at` set;
   - one row in `ctf.monitor_reviews` for the run with `route='final'`, and it has `completed_at` set, `operational_error` null and a verdict of `allow` or `block`.

A failed review attempt leaves its own row with an operational error and the retry inserts another, so "one final review row" also fails a run whose review erred and then recovered. Decision 4 asks for that. A claim a worker abandoned in a crash or a drain leaves an uncompleted final row and fails the attempt the same way.

The story asserts nothing about which verdict, about `captured`, or about the transcript, because a real model's choices vary.

The instruction is the same text in both modes. The scripted agent finds a reply by substring, so one entry keyed by the instruction answers it with `UPLOAD_COMMAND`, the only upload the Sprite fake accepts.

In `ci` the story runs in the faked suite on every pull request like any other story, with the usual violation and log checks.

### The seam

`tests/e2e/stack.ts` keeps its exported names and chooses its implementation from one variable, `E2E_STACK`, which is `real` or unset. In real mode:

| Export                                                       | Real mode                                                                                                                                                                                                         |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseUrl`                                                    | `E2E_BASE_URL`, asserted to be `https`                                                                                                                                                                            |
| `pool()`                                                     | one connection string from `E2E_DATABASE_URL`                                                                                                                                                                     |
| `newEmail`                                                   | `delivered@resend.dev`. The app's `canonicalEmail` drops a `+label`, so there is one staging member                                                                                                               |
| `signInLink`                                                 | inserts a row in `ctf.verification` whose identifier is the unpadded base64url SHA-256 of a random token, and returns the verify URL with the caller's destination. Under GitHub Actions it masks the token first |
| `takeViolations`, `takeServerFailures`, `takeWorkerFailures` | empty lists. The test cannot read Vercel's or Fly's logs                                                                                                                                                          |
| `visitorHeaders`                                             | `x-vercel-skip-toolbar: 1`, so the Vercel toolbar on a Preview cannot add console errors or failed requests                                                                                                       |
| waits and the journey limit                                  | a mode value: 12 minutes for the journey, which covers one full review attempt                                                                                                                                    |
| `mailTo`, `threadIdOf`, `grantAdmin`, `contactEmail`         | not available: each throws when called                                                                                                                                                                            |

Every variable and path the faked stack needs is read when first used, not at import, in `stack.ts` and in `run.ts`. Unset `E2E_STACK` keeps today's failure when one is missing.

`signIn` in `tests/e2e/browser.ts` runs unchanged, so submitting the form is the real Resend send, and the `signin-sent` state proves Resend accepted it. The display name is written by SQL in both modes, and in real mode only when the member has none.

The story's teardown depends on the mode. The faked stack ends the run and calls the cleanup route as the other stories do. The real stack has no cron secret to give the test, so the run's Sprite stays until the next run's start sweeps it.

Only the new story supports real mode. The runner for it is one command that the workflow calls: the Node test runner on that one file, with no build, no container and no local server. Real mode records no trace and writes no screenshot, because the repository is public and a trace holds the sign-in link and the session cookie.

### Database access in real mode

The job looks up the staging branch's connection string by the name `preview/staging` through the Neon API with `NEON_API_KEY`, masks it, and passes it to the story's step only. This is the lookup `preview-worker.yml` already does. The step refuses a branch that Neon marks as the project's default. The story's step never receives `NEON_API_KEY` and never prints the string.

The role is the database owner. A Neon branch gets its parent's roles with their passwords when it is created, and passwords are per branch afterwards. Stage A therefore resets the owner's password on `preview/staging`, so the string the test holds opens staging only. The lookup asks the API for the current password, so nothing else changes.

Rejected for now: a role for the test with only `INSERT` on `ctf.verification` and `SELECT` on the run tables. It needs a password created and stored as a new secret, and the reset already removes production's password from the job.

### The workflow

A reusable workflow `.github/workflows/staging.yml` with one input, the commit, callable from the release workflow and by hand with `workflow_dispatch` on `main` only. A dispatch from any other ref fails at its first step, because it could move `staging` to an unmerged commit and every later release's move would then be refused.

One job, `staging`, with `contents: write` and `actions: read`, a 50 minute limit, and `concurrency: { group: staging-stack, queue: max }`. Runs on staging therefore wait their turn in order, and a waiting release is not cancelled by a dispatch.

1. **Skip check.** When the repository variable `STAGING_SKIP` starts with the commit's full SHA followed by a space and a reason, write the reason to the job summary. Every later step has a condition on this step's output, so the job passes without doing anything else.
2. **Look up the database** as described above, and read its clock.
3. **Move the branch.** Update `refs/heads/staging` to the commit, without force. Record whether it moved. The token for this step only is `GITHUB_TOKEN`, or the push credential named under the risks if GitHub refuses it.
4. **Wait for the web build.** `scripts/release-deployment.ts` gains a command that waits for the commit's deployment on the git branch `staging` to be `READY` and for the branch address to serve it. It selects by `meta.githubCommitSha` and `meta.githubCommitRef`, and asks the list endpoint for that branch, on the API version that documents the `branch` and `sha` parameters, so the commit's Production deployment and another branch's Preview of the same commit are ignored.
5. **Wait for the worker.** Both must hold: a `preview worker` run for the commit whose `deploy preview worker` job succeeded, and a `worker_wake` row in staging's `ctf.settings` with an `updated_at` later than the clock read in step 2. When the branch did not move, an existing row is enough.
6. **Run the story.** If it fails, wait until the member's run holds no live lease and run it once more. Both attempts go in the job summary with their duration.

`.github/workflows/migrate-prod.yml` calls it as a new job with `migrate`'s existing condition, the two secrets it uses passed by name, and `permissions: { contents: write, actions: read }`, because a called workflow cannot hold more than its caller grants.

While the gate is advisory, no job needs `staging`: it runs beside the release, and its result is recorded without effect. Stage F adds `needs: staging` to `migrate`. A status function on `migrate` alone would not do for the advisory stage, because a failure applies to every later job in the chain: `migrate` would change production's schema and `deploy-worker` and `promote` would then be skipped.

A run by hand reaches no production job: `migrate`, `deploy-worker` and `promote` are not part of `staging.yml`.

## Stages

Each stage ends with its check. Stages A and B are operations with no code. C to F are pull requests.

| Stage | What                                                                                                                                                                                                                                                    | Verified by                                                                                                                                                                                        |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A     | Create `preview/staging` from `production` in Neon. List the tables of every schema. Create the marker role. Show the owner the scrub and wait for the yes. Scrub. The owner resets the owner role's password on the branch. Insert the two limit rows. | Every `ctf` table has zero rows except `schema_migrations`, `agent_sessions_backfill` and the two rows in `settings`. The marker role does not exist on `production`.                              |
| B     | Push `staging` at `main`'s head once, by hand.                                                                                                                                                                                                          | The build succeeds. `ctf."user"` still has zero rows, which shows the integration reused the branch. `scripts/release-check.ts` passes on the branch address. One Fly machine is tagged `staging`. |
| C     | The seam, the story, the scripted agent's reply to the instruction, offline and integration tests, `docs/verification.md`.                                                                                                                              | S1 to S4 below.                                                                                                                                                                                    |
| D     | `staging.yml`, the new command in `scripts/release-deployment.ts` with its tests. Then runs by hand.                                                                                                                                                    | S5 to S8.                                                                                                                                                                                          |
| E     | `migrate-prod.yml` calls `staging.yml` beside the release, advisory.                                                                                                                                                                                    | S9.                                                                                                                                                                                                |
| F     | After five passing releases in a row: add `needs: staging` to `migrate`, document the gate, the skip and the staging stack in `deploy/operations.md` and `docs/verification.md`. A drill.                                                               | S10, S11.                                                                                                                                                                                          |

### The scrub in stage A

Run on the direct connection of `preview/staging` only, after its branch id, name and parent are read back from Neon. The marker role is created first, in its own statement, on that branch.

```sql
CREATE ROLE ctf_staging_marker NOLOGIN;

BEGIN;
SET LOCAL lock_timeout = '10s';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ctf_staging_marker') THEN
    RAISE EXCEPTION 'Refusing: the staging marker role is missing.';
  END IF;
END $$;
TRUNCATE
  ctf.investigator_requests, ctf.text_screens, ctf.tool_call_annotations, ctf.refused_texts,
  ctf.flag_submissions, ctf.events, ctf.inference, ctf.monitor_reviews, ctf.monitor_jobs,
  ctf.finalization_jobs, ctf.sprite_operations, ctf.transcript_observations,
  ctf.agent_sessions, ctf.games, ctf.seasons, ctf.daily_spend,
  ctf.feedback, ctf.settings,
  ctf.session, ctf.account, ctf.verification, ctf."rateLimit", ctf."user"
  RESTART IDENTITY;
UPDATE ctf.schema_migrations SET billing_backup = '[]'::jsonb WHERE id = '002-dollar-seasons';
DO $$ DECLARE kept int; BEGIN
  SELECT (SELECT count(*) FROM ctf.schema_migrations WHERE id = '002-dollar-seasons')
       + (SELECT count(*) FROM ctf.agent_sessions_backfill) INTO kept;
  IF kept <> 2 THEN RAISE EXCEPTION 'Bookkeeping rows are missing; rolling back.'; END IF;
END $$;
COMMIT;
```

The table list was checked on 2026-11-28 against the inventory of branch `br-rough-cell-arr9ecu2`: schema `ctf` has these 23 tables and the two guard tables, every foreign key lies inside the truncated set, and schema `neon_auth` holds no rows apart from its own configuration. The version shown to the owner is the one that runs. There is no `CASCADE`, so a table the list misses that references a listed one fails the statement. The two guard rows stay. The one-time blocks they guard would find no rows to change, but keeping them costs two statements and leaves nothing to reason about. Production's Sprites are untouched: nothing runs on the copy before the scrub.

## Acceptance criteria

| Id  | Given, when, then                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | Given the faked suite, when `npm run test:e2e` runs three times, then every story passes each time, the new one included, with no violation and no end-of-run problem.                                                                                                                                                                                                                                      |
| S2  | Given the new story in the faked suite, when the final review's verdict is made `unknown`, when the review fails for good, when the review fails once and then succeeds, and when the upload is removed, then the story fails each time.                                                                                                                                                                    |
| S3  | Given `E2E_STACK=real`, then offline tests show that `baseUrl` refuses `http`, that the helpers with no real form throw, and that importing the stack module needs none of the faked stack's variables. An integration test shows that the row `signInLink` writes signs the member in through Better Auth's own verify handler with a session cookie and the redirect, and that an expired row is refused. |
| S4  | Given `E2E_STACK` unset, then every existing story and guard behaves as before, and `npm run check` and `npm run test:integration` pass.                                                                                                                                                                                                                                                                    |
| S5  | Given the new command in `scripts/release-deployment.ts`, then offline tests cover: a deployment on `staging` that becomes `READY`, one that ends in `ERROR`, an address that serves an older deployment until it changes, a timeout, the commit's Production deployment being ignored, and another branch's Preview of the same commit being ignored. The production lookup's tests still pass.            |
| S6  | Given a dispatch of `staging.yml` at `main`'s head, then the job moves `staging`, waits for the build and the worker, and the story passes on real services. Three passes in a row, with each run's cost read from `ctf.inference` and its duration recorded.                                                                                                                                               |
| S7  | Given `STAGING_SKIP` set to the commit and a reason, when the workflow is dispatched, then the job passes without moving the branch or starting a run, and its summary shows the reason. Given a different commit in the variable, then the job runs as usual.                                                                                                                                              |
| S8  | Given the logs and summaries on GitHub of a passing run and of a failed run, then none holds the connection string, the sign-in token or a session cookie, and no run uploads an artifact.                                                                                                                                                                                                                  |
| S9  | Given a merge to `main` with stage E in place, then the release run shows a `staging` job that passed, and production is released by the same run. Given a release whose `staging` job fails while the gate is advisory, then `migrate prod`, `deploy worker` and `promote web` still succeed.                                                                                                              |
| S10 | Given stage F and staging's daily cap set to zero for the drill, when a release runs, then `staging` fails and `migrate prod`, `deploy worker` and `promote web` do not run. With the cap restored, re-running the failed job lets the release finish. The run shows `staging` before `migrate prod`.                                                                                                       |
| S11 | Given five releases in a row before stage F, then each one's `staging` job passed.                                                                                                                                                                                                                                                                                                                          |

## Criterion, check and evidence

| Id  | Check                                                                                                                                               | Evidence |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| S1  | Three runs by the developer and three by the lead.                                                                                                  | pending  |
| S2  | The developer's mutation record. The lead repeats the first case.                                                                                   | pending  |
| S3  | The offline and integration tests, written first and seen failing.                                                                                  | pending  |
| S4  | Both commands.                                                                                                                                      | pending  |
| S5  | The offline tests, written first and seen failing.                                                                                                  | pending  |
| S6  | The three runs on GitHub, by id.                                                                                                                    | pending  |
| S7  | Two dispatched runs, by id.                                                                                                                         | pending  |
| S8  | The lead reads the logs of the runs in S6 and of one failed run.                                                                                    | pending  |
| S9  | The release run, by id, and the address serving the new commit. For the failing case, a release during the advisory stage with the cap set to zero. | pending  |
| S10 | The drill's run, by id.                                                                                                                             | pending  |
| S11 | The five runs, by id.                                                                                                                               | pending  |

## Ownership

Owned: `tests/e2e/`, the offline tests under `tests/` for the suite, `scripts/release-deployment.ts` and its test, `.github/workflows/staging.yml`, the `staging` job and the `needs` line in `.github/workflows/migrate-prod.yml`, one script line in `package.json` if the workflow needs it, `docs/verification.md`, `deploy/operations.md`, this plan.

Not owned: `app/`, `lib/`, `db/`, `scripts/monitor-worker.ts`, `.github/workflows/preview-worker.yml`, `.github/workflows/ci.yml`.

A test in the commit hook's environment must not run `git` without first deleting every `GIT_` variable.

## Non-goals

- More than one real story.
- Reading Vercel's or Fly's logs from the test.
- A pinned model for staging. An empty `ctf.settings` gives the code's defaults, which are the cheap ones.
- Proving the worker's wake path. The worker polls every second for its first ten minutes, and a first attempt after a move runs inside that window. A retry or a run on an unmoved branch may fall outside it and then does exercise the wake.
- The Sprite's deny rule. The upload proves the allow rule.
- Fixing pull request previews, which are copies of production with a worker each.

## Risks and open questions

- **The model may not obey.** With no upload there is no receipt and the attempt fails at its limit. The live smoke had this failure before its instruction was changed to one exact command. Stage D measures it over three runs before anything depends on it.
- **A review can stall.** An investigator error retries at 1, 5, 15 and 40 minutes. The attempt fails at 12 minutes. The retry starts a new run, which is refused while the first still holds a live lease or an upload awaits its command, so the step waits for the lease to clear first. A run stalled in `finalizing` counts against the ten open environments until it settles.
- **Moving `staging` with `GITHUB_TOKEN` is likely to be refused** when the new commit changes a workflow file, and stages D, E and F each change one. Stage D's first dispatch shows it. The fallback is a write deploy key for this repository: its private half is generated on the owner's machine and stored as an Actions secret without being shown, and it is given to the move step only. Neither a deploy key nor an owner's token can push to `main`, whose rulesets let an admin bypass only by merging a pull request. The key is the narrower credential: one repository, git only, no API. Unlike `GITHUB_TOKEN`, a push with it starts `push` workflows, and none listens to `staging` today. Whether a deploy key may push commits that change workflow files is not documented; the first move shows it. The owner approves the key before it is made.
- **Vercel may not build a ref moved by the workflow,** or a commit that already has a production build. Stage B shows the second, stage D the first.
- **The integration may not adopt a branch made by hand, or may not pick up the reset password.** Stage B's zero-row check shows it. If it made a fresh copy instead, the stack is taken down before anything else runs and the owner is asked.
- **Another branch at the same commit can misroute the worker deploy,** because `preview-worker.yml` takes the first branch that is not `main`. The worker wait then times out and the job fails.
- **Staging is public and must stay so,** because the Sprite cannot send a protection header. Anyone who finds the address can sign in and spend up to the $2 cap, or exhaust it so the gate fails.
- **Two merges close together.** The release workflow keeps one run going and one waiting. The staging job lengthens each release by a few minutes, which widens the window in which a middle merge is released only as part of the next one.
- **A failure of the plumbing counts as a failure,** the same as a failed story: the build, the worker deploy and the waits are part of what a release depends on.
- **Unverified:** that re-running a failed job reads a changed repository variable. S7 uses fresh dispatches. Stage F's drill shows the re-run case.

## Plan verification

An independent read-only check on 2026-11-28 approved with changes, all folded in, and a second read of the changed plan confirmed them. It confirmed by reading that the scrub's table list is complete, that the two limit rows are valid stored values, that a cap of zero refuses at admission and touches nothing in production, that Better Auth accepts the verification row as designed, and that nothing stops the test recipient signing in on a Preview.

- The caller grants the permissions, because a called workflow cannot raise them, and it carries `migrate`'s condition so a commit that failed `ci` never reaches staging.
- In the advisory stage nothing needs `staging`. `continue-on-error` cannot be used on a calling job, and a status function on `migrate` would leave the later jobs skipped after a failure, found on the second read. S9 gained the failing case.
- A concurrency group with a full queue replaces a one-way check for a release in flight. A dispatch is refused off `main`.
- The deployment wait selects by git branch, because a Preview has no target to filter on and the commit always has a Production deployment too.
- The story reuses `waitForReviews`, so a review that erred and recovered fails the attempt, as decision 4 asks.
- The sign-in token is masked, and S8 reads a failed run too, because a failed navigation prints its URL.
- The production host check is gone. The lookup refuses the default branch, and the owner's password is reset on staging.
- Smaller changes: the toolbar header, lazy reads in the stack module, a teardown per mode, an integration test for the sign-in row, the `preview worker` run as a second condition of the worker wait, a commit input, a job limit, named secrets.

Not taken: truncating the two guard tables as well. The verifier read both one-time blocks as doing nothing on empty tables.

Still unverified, each with the stage that shows it: whether Vercel builds a ref moved by the workflow, whether the integration adopts the branch and the reset password, whether a re-run reads a changed variable, and whether the fakes can produce an `unknown` verdict for S2.
