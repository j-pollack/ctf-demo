# Release gate, part 4: promotion owned by the release workflow

Worktree: `/Users/jonathan/Code/ctf/.worktrees/release-promotion`
Branch: `feature/release-promotion`
Baseline: `5380b8c5` on `main`, clean tree, nothing staged.
Request: the user asked for end-to-end tests that gate deployment and agreed on 2026-11-26 to a four-part plan, published at https://artifacts.jonathanpollack.dev/a/KEZTBv9jcVBeLiMn. This contract covers part 4. On the same day the user gave permission to turn off Vercel's automatic production domain assignment and to keep a Vercel token in GitHub Actions.

Roles: lead Claude Fable 5.2. Plan verifier and code reviewer Claude Opus, high effort, read-only. Developer Claude Sonnet, medium effort. The user allowed commits, pushes and pull requests. Merging needs the user's yes.

## Problem

Vercel assigns the production domain by itself. In the last four releases the domain moved before `deploy worker` finished, and once before the migration started. For commit `5380b8c` the new web code ran against the old worker for nearly 13 minutes. `deploy/operations.md` says the domain waits for `ci`, `migrate prod` and `deploy worker`, but that order lives in a Vercel dashboard setting the repository cannot see. Nothing checks the new deployment before the domain moves, and nothing checks the site after.

## Scope

The `migrate prod` workflow gains one job, `promote`, after `deploy worker`. It finds the production deployment Vercel built for the commit, waits for it, sends read-only checks to that deployment's own URL, moves the production domain to it, repeats the checks on the live domain, and rolls the domain back if they fail.

## Non-goals

- The real mode of the browser suite on a staging stack. It is part 3 and will run before `migrate` in the same workflow.
- Turning off "Auto-assign Custom Production Domains" in Vercel. The lead changes that setting after this change is on `main` and its first run has passed. See "Rollout".
- Rolling back the migration or the worker when a release fails. `deploy/operations.md` keeps the manual procedure.
- A signed-in check on production. Sign-in there is pinned to the production origin, and a signed-in run would write to the production database.
- A check that every runtime variable exists in Vercel's Production environment. The build already fails on a missing limit variable. A missing mail, model or Sprite credential would pass these checks.
- A committed test that parses the workflow file. The repository has no YAML parser among its own dependencies.
- Changes under `app/`, `lib/`, `db/` and `package.json`.

## Facts this design rests on

From the repository, Vercel's documentation and read-only requests the lead made on 2026-11-26.

- With automatic assignment off, a push to `main` still builds a production deployment. It stays staged on its own URL until promoted. With it on, Vercel promotes the deployment itself.
- `GET /v6/deployments?projectId=<id>&teamId=<id>&target=production` lists production deployments with `uid`, `url`, `state`, `created` and `meta.githubCommitSha`. All four latest deployments showed `readySubstate: PROMOTED`, so that field means "was promoted once" and does not say which deployment serves now.
- `GET /v4/aliases/<production host>` returns the `deploymentId` that serves the domain now and `updatedAt`, the time the domain last moved. On 2026-11-26 it named the deployment for `5380b8c` and a time that matches the gap table on the plan page.
- `GET /v13/deployments/<id>` returns one deployment with its `url` and `meta.githubCommitSha`. The lead read it for the serving deployment on 2026-11-26.
- `vercel promote <url>` moves the production domains to a staged production build without rebuilding. `vercel rollback <url>` moves them back to a deployment that served production before. Both take `--scope` and `--timeout`. Vercel's documentation names the `VERCEL_TOKEN` environment variable as the way to authenticate in CI, and says `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` in the environment skip project linking. It does not state the exit code when the timeout elapses, so the job verifies the domain itself after promoting. The team is on the Pro plan, which allows rollback to older deployments.
- Deployment URLs are public for this project. It has no Vercel authentication on them.
- The live site at the production origin answered on 2026-11-26: `GET /v1/end` 405, unauthenticated `POST /v1/end` 401, and 200 for `/`, `/rules`, `/rank`, `/contact`, `/signin` and `/api/leaderboard`.
- On a deployment's own URL, an unauthenticated `POST /v1/end` returns 400 as the code stands, because the route compares the request host with the production host before it reads the token (`app/v1/end/[[...token]]/route.ts:89`, `lib/flag-submission-protocol.ts:34-39`). The production host is `SITE_URL` or else `VERCEL_PROJECT_PRODUCTION_URL`. The lead observed it on 2026-11-26 by running the check script against the current production deployment's own URL. An `Origin` header or a query string would change the result, so the checks send neither.
- `/api/leaderboard` is the one checked route that proves the database: it returns 503 when the database fails. `/` and the game pages fall back to defaults and still return 200.
- A web rollback does not undo the migration or the worker image.

## Design

1. **Checks** `scripts/release-check.ts`. One exported function takes a base URL, a mode and a `fetch`, and returns the list of mismatches. The mode is `deployment` for a deployment's own URL and `live` for the production origin. Expected results:

   | Request                                           | `deployment`                         | `live`   |
   | ------------------------------------------------- | ------------------------------------ | -------- |
   | `GET /`, `/rules`, `/rank`, `/contact`, `/signin` | 200, `text/html`, the page's marker  | the same |
   | `GET /api/leaderboard`                            | 200 and JSON with an `entries` array | the same |
   | `GET /v1/end`                                     | 405                                  | 405      |
   | `POST /v1/end` with no token and no body          | 400                                  | 401      |

   A page's marker is the `data-testid` on its root element, such as `page-rules`, as the attribute appears in the server HTML. Each request has a timeout, follows no redirect, and sends no `Origin` header, no query string and no credentials. A timeout or a connection failure is a mismatch. Run as a script, it prints each request with its status and exits non-zero on any mismatch.

2. **Deployment state** `scripts/release-deployment.ts`. Exported functions take the ids, a token, a `fetch` and a clock.
   - **Lookup.** It polls the list endpoint with a stated `limit` until the newest production deployment for the commit, by creation time, is `READY`. It returns that deployment's id, URL and creation time. It throws when that newest deployment is `ERROR` or `CANCELED`, and when none is ready within eight minutes. Deployments for other commits and older deployments for the same commit are ignored.
   - **Serving.** It reads the alias for the production host for the id of the deployment that serves it now, then reads that deployment by id for its commit. The serving deployment can be older than anything in the list, for example after a rollback.
   - **Decision.** A pure function takes the two deployment ids and how the new commit relates to the serving commit in Git history. It returns `already-serving` when the ids are the same, `promote` when the new commit is the serving commit or a descendant of it, and `refuse` in every other case: the new commit is behind, the histories diverged, or the serving deployment or its commit could not be read. Creation time is not used, because redeploying an old commit gives it a new one. The relation comes from `git merge-base --is-ancestor` on the job's checkout, which fetches the full history.

   Run as a script, it writes the new deployment's id and URL, the serving deployment's id and the decision to `GITHUB_OUTPUT`. The token is read from the environment and never printed.

3. **The job** `promote` in `.github/workflows/migrate-prod.yml`, `needs: deploy-worker`, with a 30 minute timeout. Steps:
   1. Check out the commit with its full history, set up Node, `npm ci`.
   2. Look up the deployment, read the serving deployment and decide. Fail the job on `refuse`, naming both deployments. On `already-serving`, write a warning that Vercel promoted it or an earlier attempt did.
   3. Run the checks in `deployment` mode against the new deployment's URL.
   4. On `promote`, promote with the pinned Vercel CLI and wait for the domains to move. When the command fails, read the serving deployment and pass the step when it is the new one.
   5. On `promote`, read the serving deployment again and fail unless it is the new one.
   6. Run the checks in `live` mode against the production origin. When they fail on `already-serving`, point to the procedure in `deploy/operations.md`.
   7. Roll back to the deployment recorded in step 2 when step 4 started in this run and steps 4 to 6 did not all succeed, including when the job was cancelled. In the workflow this is `always()`, the promote step's outcome not `skipped`, and not all three of promote, verify and live `success`. Then fail the job. Rolling back to the deployment that already serves changes nothing.

   The lookup, the promote and each set of checks have their own `timeout-minutes`, which add up to less than the job's, so the job's timeout is never what stops them and the rollback step gets its turn.

   The Vercel token is passed through the environment variable `VERCEL_TOKEN`, only to the steps that call Vercel. The CLI runs with `npx` at one pinned version.

4. **Configuration.** The secret `VERCEL_TOKEN`, created and stored by the user. The repository variables `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` and `PRODUCTION_ORIGIN`, set by the lead. A variable is used for the origin so that logs show it.

5. **Documentation.** `deploy/operations.md`:
   - The release order names the `promote` job and its checks, and the sentence about configuring Vercel's production alias is replaced.
   - A new rule beside the additive-migration rule: the worker must stay compatible with the previous web release, because a release that stops before promotion leaves the new schema and worker under the old web deployment.
   - How to finish a stopped release: fix the cause and re-run the `promote` job, or run the checks against the deployment URL by hand and then `vercel promote`. The next good release also replaces it, because it promotes its own build.
   - Re-running an older release's `promote` after a newer release stopped before promotion puts the older web code under the newer schema and worker. The compatibility rule covers this case too.
   - How to undo one: the existing worker rollback. The migration stays.
   - What a web rollback leaves in place.

## Rollout

1. **Merge with automatic assignment still on.** Vercel promotes as it does today. The job runs both sets of checks. It usually finds the new deployment already serving and skips its own promote. If Vercel's own gate is still holding the deployment, the job promotes it. This step proves the token can read, the lookup, the serving read, and the expected statuses in both modes, including the unobserved 400. It does not prove the token's right to promote, the CLI flags, or rollback.
2. **A drill in a quiet window, with the user's yes at that time.** The lead runs the pinned CLI by hand: roll back to the previous production deployment, then return to the current one. The two releases are compatible because migrations are additive. The lead records the commands, how long each took, and the project's automatic-assignment setting afterwards.
3. **The lead turns automatic assignment off** and asks the user to remove the Deployment Checks selection in the dashboard.
4. **The next release** finds a staged deployment and promotes it. The lead watches that run and reads the project setting afterwards. Vercel's documentation says a promote after a rollback can turn automatic assignment back on.
5. **A follow-up change** makes `already-serving` on a first attempt a failure, so the setting drifting back on stops a release.

### Rollout record

- **Step 1, 2026-11-27.** The token was set and the job observed two releases. See P8.
- **What Vercel waited for.** The project's Deployment Checks listed `ci` and `migrate prod`. The `e2e` job and `deploy worker` were not in the list, and a skipped check counted as passed: after a re-run of `ci` for `2be3819` the domain moved at 02:47:47 UTC, three seconds before the new `migrate prod` started. The user added `e2e` and `deploy worker` to the list. In the next release, `2b5e407`, the domain moved at 06:36:33, five seconds after `deploy worker` finished.
- **Step 2, the drill.** See P9. Promoting the deployment that is already live exits 1 with a 409, so the race the second review found was real.
- **Step 3.** Automatic assignment was turned off at 23:11 UTC on 2026-11-27 with the user's yes, and read back as `false`.
- **Open after the drill.** A promote turned automatic assignment back on after a rollback. Whether every promote does so is read from the setting after step 4. If it does, the job has to turn the setting off again after it promotes, and step 5 waits for that.

## Tradeoffs considered

- **One job against three.** Find, check, promote and verify share state: the deployment URL, the decision and the deployment to roll back to. One job keeps that in step outputs.
- **The CLI for promote and rollback, the REST API for reads.** The CLI documents its waiting behaviour for both commands. The reads need polling and filtering by commit, which small functions do and offline tests cover.
- **Checks before the migration.** New code may need the new schema, so a check before `migrate` could fail for a healthy release. The checks stay after `deploy worker`.
- **Keeping Vercel's Deployment Checks.** They need automatic assignment on, cannot run a check against the deployment, and cannot roll back.
- **`readySubstate` as the "already promoted" signal.** The first draft used it. The plan verifier showed that a re-run after a cancelled promote would then skip the rollback, so the job reads the alias.

## Acceptance criteria

| Id  | Given, when, then                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | Given responses that match the table for a mode, when the check function runs, then it returns no mismatch. Given any one response that differs in status, content type, marker or body shape, then it returns that request with the expected and actual values. Given a request that times out or fails to connect, then it is a mismatch and not a thrown error. Each request it sends has no `Origin` header, no query string and no credentials.                                      |
| P2  | Given a `POST /v1/end` that returns 401, when the mode is `deployment`, then it is a mismatch, and when the mode is `live`, then it passes. Given 400, the reverse.                                                                                                                                                                                                                                                                                                                       |
| P3  | Given a list response with several deployments for the commit, when the lookup runs, then it judges only the newest by creation time: `READY` returns its id, URL and creation time, a deployment still building is polled again, and `ERROR` or `CANCELED` throws naming the state. Given nothing ready after ten minutes on the injected clock, then it throws. Deployments for other commits are ignored.                                                                              |
| P4  | Given the two deployment ids and the relation of the new commit to the serving commit, when the decision runs, then it returns `already-serving` for the same id, `promote` when the new commit is the serving commit or a descendant, and `refuse` when it is behind, diverged, or the serving deployment or its commit could not be read. Given an alias that names a deployment missing from the list, then the serving read still returns its commit by reading the deployment by id. |
| P5  | Given the script run with a token in its environment, when it prints or fails, then the token does not appear in its output.                                                                                                                                                                                                                                                                                                                                                              |
| P6  | Given the workflow file, then `promote` needs `deploy-worker` and checks out the full history, the job fails on `refuse`, the promote step runs only on `promote`, the rollback step runs whenever the promote step started and the steps after it did not all succeed, the lookup, promote and check steps each have a timeout below the job's, the job fails whenever a check fails, and the token is passed only to the steps that call Vercel.                                        |
| P7  | Given the change, when `npm run check` runs, then it passes, and the workflow YAML parses.                                                                                                                                                                                                                                                                                                                                                                                                |
| P8  | Given the first release after the merge, with automatic assignment on, then the `promote` job's log shows each check's status in both modes and the decision. The job passes on `already-serving` or `promote`. A `refuse` because Vercel already promoted a newer commit is also an accepted outcome of this step.                                                                                                                                                                       |
| P9  | Given the drill, then rollback and the return each move the production domain, shown by the alias read before and after.                                                                                                                                                                                                                                                                                                                                                                  |
| P10 | Given the first release after automatic assignment is turned off, then the decision is `promote`, the alias's `updatedAt` is later than the end of `deploy worker`, and the live checks pass.                                                                                                                                                                                                                                                                                             |

## Criterion, check and evidence

| Id       | Check                                                                                                                                                                                                      | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1, P2   | Offline tests of the check function with a stub `fetch`, written first. The stub records each request's URL and headers.                                                                                   | Passed. Eleven offline tests in `tests/release-check.test.ts`, nine seen failing first. Run for real by the lead on 2026-11-26: the production origin in `live` mode matched all eight requests, the current production deployment's own URL in `deployment` mode matched all eight including the 400, and the production origin in `deployment` mode exited 1 with "expected 400, got 401".                                                        |
| P3 to P5 | Offline tests of the lookup, the serving read and the decision with a stub `fetch` and an injected clock, written first. One test captures the script's output with a known token and asserts its absence. | Passed. Fifteen offline tests in `tests/release-deployment.test.ts`. The token test runs the script as a child process against a loopback server that echoes the Authorization header, and finds the token in no output. The lookup has not run against Vercel.                                                                                                                                                                                     |
| P6       | The lead reads the job against the list in P6.                                                                                                                                                             | Read by the lead: `needs: deploy-worker`, full-history checkout, promote and verify only on `promote`, a failed promote passing only when the domain serves the new deployment, the rollback condition as written in design item 3, step timeouts of 11, 1, 4, 2 and 1 minutes plus 4 for the rollback against the job's 30, and the token in the environment of the decide, promote, verify and rollback steps only. `actionlint` reports nothing. |
| P7       | `npm run check`, and a one-off parse of the workflow file.                                                                                                                                                 | Passed. `npm run check` 694 of 694 with `main` at `5d7c652` merged in. The workflow parses, with jobs `migrate`, `deploy-worker` and `promote`.                                                                                                                                                                                                                                                                                                     |
| P8       | The lead reads the first run on `main` after the merge.                                                                                                                                                    | Run `45931378069`, second attempt, for `a4cf095` on 2026-11-27, the first with the token: decision `already-serving`, every request matched in both modes, nothing promoted. Run `45952741901` for `2b5e407`: all three jobs passed, decision `already-serving`.                                                                                                                                                                                    |
| P9       | The lead's record of the drill.                                                                                                                                                                            | Drill on 2026-11-27 with the pinned CLI. `rollback dpl_HzScD2JgYnqAUqZXaz3nmLX3MN8A` took 3 seconds and the domain served it at 06:27:27 UTC. `promote` of the `a4cf095` deployment by URL took 2 seconds and the domain served it at 06:27:41. The live checks passed after each. Automatic assignment read `false` after the rollback and `true` after the promote.                                                                               |
| P10      | The lead compares the alias time with the job times for the first release after the switch.                                                                                                                | pending until the switch                                                                                                                                                                                                                                                                                                                                                                                                                            |

No test in this change calls Vercel. The offline tests use stubs at the Vercel boundary, and P8 to P10 are the real-service checks.

## Steps

1. Baseline: `npm run check` passes on the untouched worktree.
2. The check function with its offline tests, then the script entry. Verify: P1 and P2 fail first, then pass.
3. The lookup, the serving read and the decision with their offline tests, then the script entry. Verify: P3 to P5 fail first, then pass.
4. The `promote` job. Verify: P6 and P7.
5. `deploy/operations.md`. Verify: `npm run check`.

## Ownership

Owned paths: `scripts/release-check.ts`, `scripts/release-deployment.ts`, their offline tests under `tests/`, `.github/workflows/migrate-prod.yml`, `deploy/operations.md`, this plan.

Not owned: `app/`, `lib/`, `db/`, the other workflows, `package.json`.

## Changes after the first review

**Page markers are test ids.** The markers were sentences of copy. On 2026-11-26 `main` gained new copy in `953c9ad`, production moved to that commit, and the live check then failed on `/`, `/rules` and `/rank` with the site healthy. Pull request 50 put a `data-testid` on each page's root. This branch took `main` at `5d7c652`, and each page check now looks for `data-testid="<id>"` in the HTML. An offline test fails when a checked id is missing from the files under `app/`. The lead saw it fail with `page-rules` misspelled, and ran both modes against production on 2026-11-26 at `5d7c652`: every request matched.

**The ancestry test cleared no Git variables.** `tests/release-deployment.test.ts` builds a temporary repository with `git init` and `git commit`. A commit hook exports `GIT_DIR` and `GIT_INDEX_FILE`, so on the first commit of this branch those commands acted on this repository: they wrote eleven commits to the feature branch and set `core.bare` to true in the shared config, which stopped Git in the primary checkout. The lead set `core.bare` back to false, moved the branch back with a soft reset so no file changed, and the test file now deletes every `GIT_` variable before it runs, as `tests/seed.test.ts` does. Run with `GIT_DIR` pointing at a throwaway repository, the file failed 4 of 24 before the fix and passed 24 of 24 after it, with the throwaway repository untouched.

**Second review, 2026-11-26.** An independent review of the whole branch at `47388aa` found no P0 or P1 and one P2. The user chose the same day to have it fixed.

- **P2, a promote that races Vercel's own promotion.** While automatic assignment is on, Vercel can move the domain between the decision and `vercel promote`. If the command then fails, the rollback ran and undid a healthy release. The promote step now reads the domain when the command fails and passes when it serves the new deployment.
- The read of the serving deployment is tried once more after a 5xx, a 429 or no answer, so one bad read after a promotion does not roll it back.
- The lookup step's timeout is 11 minutes. The lookup's worst case is its 8 minute deadline, one more poll and three reads of up to 30 seconds each. The verify step's timeout is 2 minutes, so a first read that hangs for its full 30 seconds still leaves time for the second.
- A third pass by the same reviewer confirmed the P2 closed with nothing new at P0 to P2.

Limits that stay, by design:

- The live checks pass on any healthy deployment. The proof that the domain moved is the verify step's read of the domain.
- The test ids for `/rules`, `/rank` and `/signin` sit on the shared game layout. They prove the page rendered on the server at that path, and a render error still answers 500. They do not prove the panel has content.
- The offline test for the ids proves each id exists under `app/`. It does not tie an id to a path. The browser suite's page stories do.

## Risks and open questions

- **A release that stops before the promote step.** With automatic assignment off, the migration and the new worker are in place while the old web deployment keeps serving. Today the opposite skew happens on every release. Design item 5 documents the rule and the procedures.
- **The 400 on a deployment URL is a reading of the code.** It depends on Vercel exposing its system variables and on the production host matching `PRODUCTION_ORIGIN`. Rollout step 1 observes it before the job owns promotion. If it differs, the table changes before the switch.
- **Promote and rollback are unproven until the drill.** The developer cannot call Vercel, so the CLI flags come from its help output and documentation.
- **Automatic assignment drifting back on.** Rollout steps 4 and 5 cover it.
- **Several releases in a row.** The workflow's concurrency group runs releases one at a time, and `promote` holds it, so the next migration waits. A re-run of an old release's `promote` after a newer release is live ends in `refuse`, because its commit is behind the serving one.
- **A firewall challenge or deployment protection added later** would block requests from GitHub's runners. The job would fail before promoting.

## Plan verification

An independent read-only check on 2026-11-26 blocked the first draft on two findings and listed six more. All are folded in: the serving deployment is read from the alias, an older commit is refused, the rollback condition covers a failed or cancelled promote, the lookup judges the newest deployment for a commit, the checks require a content type and a page marker, the workflow test is dropped for want of a parser, the rollout says what its first step does not prove and adds a drill, and `deploy/operations.md` gains the stopped-release procedure. The lead then confirmed the alias read against the live project. A second pass approved with should-fix changes, all folded in: the decision uses Git ancestry and not creation time, the serving deployment is read by id and an unreadable one is refused, the steps have their own timeouts, and the rollout's first step accepts a refusal caused by a newer commit.
