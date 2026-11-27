# The response time limit as an admin setting

Worktree: `/Users/jonathan/Code/ctf/.worktrees/response-time-limit`
Branch: `feature/response-time-limit`, from `main` at `5d7c652`. Clean tree.
Request: on 2026-11-26 the lead reported that auto-continue cannot be tested in a browser, because the server starts it only when a response reaches a hard-coded 230 second limit. The user chose: "Make it configurable like other admin variables".

Roles: lead Claude Fable 5.2. Plan verifier and code reviewer Claude Opus, high effort, read-only. Developer Claude Sonnet, medium effort. The user allowed commits, pushes and pull requests. A merge and any change to Vercel or Fly settings need the user's yes.

## Problem

`app/api/games/[id]/prompt/route.ts` stops a response with `AbortSignal.timeout(230000)`. When that fires, the stored event is marked `resumable` and `autoContinue`, and the browser sends "Continue." up to the stored number of turns. The number is a literal, so:

- an admin cannot shorten or lengthen a response without a release;
- no test can reach the limit in less than 230 seconds, so no integration test asserts the marks on the route's path and no browser story can cover auto-continue.

Twelve other values of this kind are admin settings in `lib/limits.ts`: a stored value, else a `CTF_` environment variable, else a default in code, with bounds fixed in code.

## Scope

A thirteenth setting, the response time limit in seconds, read by the prompt route.

## Non-goals

- The 270 second session lease, the route's `maxDuration` of 300, the 45 second stream idle bound and the 20 second wait for a stop. They keep their values.
- The browser's auto-continue rules and the player-facing copy.
- A browser story for auto-continue. It belongs to the release gate's run stories and builds on this.
- The defect in `lib/runner-async.ts` where a 504 with an unfired deadline signal is not marked. It has its own branch, `fix/auto-continue-stall`.

## Design

1. **The setting.** `lib/limits.ts` gains one entry in `LIMITS`: key `response_seconds`, field `responseSeconds`, kind `count`, default 230 from a new constant `RESPONSE_SECONDS` in `lib/policy.ts`, minimum 5, maximum 230. It sits after `auto_continue_turns` and before the two effort entries, because the card test matches labels to the registry by position. `.env.example`, the documentation table and the Fly command use the same order. `Limits` in `lib/types.ts` gains the field. It is not part of `PlayerLimits`: the browser does not read it.
2. **Bounds.** The maximum stays 230 so the response still ends 40 seconds before the lease and 70 before the platform's limit, as today. The minimum is 5 so a test and a browser story can reach the limit quickly. A stored value outside the bounds is ignored, as for every other setting.
3. **The route.** The prompt route already reads `currentLimits()` for the agent effort. It reads the limits once and builds the deadline from `responseSeconds * 1000`. Nothing else in the route changes. A failed read of the limits fails the request as it does today.
4. **The admin card.** `app/admin/limits-card.tsx` gains the label "Response time limit (seconds)". The card renders the row from the registry, with its range hint, like the other count rows.
5. **The environment variable.** `CTF_RESPONSE_SECONDS`, default `230`, joins `.env.example` and `deploy/operations.md`. In that file it touches the list of the card's values, the three sentences that count the settings, the variable table, the commands, and the paragraph on bounds, which gains "5 to 230 seconds for the response time limit" and one sentence that values far below 230 are for tests. The Vercel build check and the worker workflows' check read the registry, so they require the new variable without a code change. Three comments that state the count of twelve, in `scripts/vercel-build.ts` and the two worker workflows, are reworded to state no count.
6. **Tests.**
   - Offline, in `tests/limits.test.ts`, `tests/admin-limits-card.test.ts`, `tests/vercel-build.test.ts` and `tests/check-limit-env.test.ts`: the default, the bounds, a stored value over an environment value, an invalid stored value falling back, the card row with its label and its range of 5 to 230, and the environment check naming the new variable when it is missing.
   - Integration, in `tests/integration/limits.test.ts`: saving `response_seconds` through the admin path accepts 5 and 230 with the admin recorded as the changer, and refuses 4 and 231 without storing.
   - Integration, new, in `tests/integration/sprites.test.ts` beside S7: with `setLimit("response_seconds", 5)` and `agentStreamMode = "endless"`, a call to the real prompt route through the suite's `respond` or `instructFrames` helper, wrapped in `withinSeconds(…, 10)`. It asserts status 200, an elapsed time of at least 5 and under 9 seconds around reading the whole body, a last frame of `done`, exactly one stored error event with `resumable` and `autoContinue` both true, the run `active` and not busy, the lease cleared and no command run. It does not assert the event's text: two texts are possible on this path and both carry the marks.

## Rollout

The deploy check fails a build or a worker deploy when a required variable is missing. It runs in four places:

- the Vercel build of every preview, this pull request's own included;
- the Vercel production build after a merge;
- the `preview worker` workflow, after a preview deployment succeeds, against the preview worker app;
- the `migrate prod` workflow's worker job, after a merge, against the production worker app.

`ci` and the browser suite do not need the variable.

Order, each step with the user's yes before any command that changes Vercel or Fly:

1. Set `CTF_RESPONSE_SECONDS=230` in Vercel Production and Preview and as a Fly secret on both worker apps, with one command per place for this one variable. The Fly commands use `flyctl secrets set --stage`, as `deploy/operations.md` does, so setting the secret does not restart a worker. The loop in `deploy/operations.md` is not used, because it would add the twelve existing variables again.
2. Redeploy the pull request's preview, or push a commit, so a build runs with the variable.
3. Confirm the Vercel preview build and the `preview worker` run for the pull request's head both pass.
4. Confirm the production names with `vercel env ls production` and `flyctl secrets list --app ctf-monitor-worker`. Nothing before the merge exercises the two production checks.
5. Merge.

## Acceptance criteria

| Id  | Given, when, then                                                                                                                                                                                                                                                                                                                                        |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1  | Given no stored value and no variable, when the limits are resolved, then `responseSeconds` is 230. Given a stored `response_seconds` of 5, 60 or 230, then that value is used. Given 4, 231, a decimal or text, then the stored value is ignored and the next layer applies.                                                                            |
| L2  | Given `CTF_RESPONSE_SECONDS` missing or invalid, when the environment check runs, then it names the variable. Given all thirteen valid, then it passes.                                                                                                                                                                                                  |
| L3  | Given a stored limit of 5 and an agent stream that never ends, when a member posts an instruction to the prompt route, then the response ends between 5 and 9 seconds later with a last frame of `done`, exactly one error event is stored with `resumable` and `autoContinue`, the run is active and not busy, the lease is cleared and no command ran. |
| L4  | Given the admin path, when `response_seconds` is saved as 5 or 230, then it is stored with the admin as the changer, and 4 or 231 is refused and stores nothing. Given the card rendered offline, then it shows the row with its label, the current value and the range 5 to 230.                                                                        |
| L5  | Given the documentation, `.env.example` and the code comments outside `docs/plans/`, then each list holds thirteen variables, including `CTF_RESPONSE_SECONDS` at `230`, and no text still says twelve settings.                                                                                                                                         |
| L6  | Given the whole change, when `npm run check`, `npm run test:integration` and `npm run test:e2e` run, then all pass.                                                                                                                                                                                                                                      |

## Criterion, check and evidence

| Id  | Check                                                                                                                      | Evidence                                                                                                                                                                                                                                                            |
| --- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1  | Offline tests in `tests/limits.test.ts`, seen failing first.                                                               | `tests/limits.test.ts`. Before the registry entry, 9 of 32 offline tests failed on the missing entry. They pass now.                                                                                                                                                |
| L2  | Offline tests of the environment check and the build script, seen failing first.                                           | `tests/check-limit-env.test.ts` and `tests/vercel-build.test.ts`: missing names the variable, and 4, 231 and 5.5 are invalid.                                                                                                                                       |
| L3  | The new integration test. Red evidence: with the literal still in the route, this test alone fails on its 10 second bound. | `L3: a response that reaches the stored response time limit ends marked to continue`. With the literal in the route it failed with "still running after 10s" and no other test in the file failed. It passes in 5.1 seconds, in the developer's run and the lead's. |
| L4  | `tests/integration/limits.test.ts` and `tests/admin-limits-card.test.ts`, extended.                                        | `tests/integration/limits.test.ts`: 5 and 230 stored with the admin's id, 4 and 231 refused with 400 and nothing stored. `tests/admin-limits-card.test.ts`: the label, 230, and the range 5 to 230.                                                                 |
| L5  | The offline test that reads `.env.example`, and a search for "twelve" by the lead.                                         | The `.env.example` test checks thirteen variables. A search outside `docs/plans/` finds "twelve" only for the investigator's limit on cited calls.                                                                                                                  |
| L6  | The three commands, by the developer and by the lead.                                                                      | Lead on 2026-11-26: `npm run check` 656 of 656, `npm run test:integration` 650 of 650, `npm run test:e2e` 13 of 13.                                                                                                                                                 |

## Steps

1. Offline tests for L1 and L2. Verify: they fail for want of the entry.
2. The registry entry, the type, the constant and the label. Verify: L1, L2 and the card test pass.
3. The integration test for L3. Verify: it fails on its 10 second bound because the route still waits 230 seconds. The integration runner takes file paths only, so the red run executes the whole file, and the held response may disturb later tests in it. Only this test's failure counts as the red evidence.
4. The route. Verify: L3 passes.
5. `.env.example`, `deploy/operations.md` and the counts. Verify: L5, then L6.

## Ownership

Owned: `lib/limits.ts`, `lib/policy.ts`, `lib/types.ts`, `app/api/games/[id]/prompt/route.ts`, `app/admin/limits-card.tsx`, `.env.example`, `deploy/operations.md`, the one comment that states the count in each of `scripts/vercel-build.ts`, `.github/workflows/migrate-prod.yml` and `.github/workflows/preview-worker.yml`, the offline tests named in design item 6, `tests/integration/limits.test.ts`, one new test in `tests/integration/sprites.test.ts`, this plan.

Not owned: `lib/runner-async.ts`, `lib/sessions.ts`, `lib/inference.ts`, anything else in the workflows or `scripts/`, `tests/e2e/`.

A test in the commit hook's environment must not run `git` without first deleting every `GIT_` variable.

## Risks and open questions

- **A thirteenth required variable.** Missing it fails production builds and worker deploys. The rollout section orders the work so it exists first.
- **A very short limit in production.** An admin who stores 5 makes every response stop after five seconds and auto-continue. The bounds allow it, the card shows the range, and the change is one field to undo. Two effects follow at low values. Most agent calls are cut in mid-stream, and each leaves its hold at the ceiling for at least two minutes until it is reconciled, so a chain of continues can be refused with "Some billing is still pending" once the holds use up the run budget. That refusal is not resumable, so the chain stops and the run stays open. And every command longer than the limit comes back interrupted.
- **The same file as the stall fix.** Branch `fix/auto-continue-stall` also adds a test beside S7. Whichever merges second takes `main` first.
- **Places that state the limit in words.** If any player-facing copy or code comment says 230 seconds or names the limit as fixed, the developer lists it in the report and changes nothing outside the owned paths.
- **The worker.** It reads the same registry and would hold a value it never uses. Its deploy check still requires the variable.

## Plan verification

An independent read-only check on 2026-11-26 approved with changes, all folded in: the rollout names the four places the check runs and confirms the production names before the merge, three comments that state the count are owned, every place in `deploy/operations.md` is listed, the integration test for L3 is pinned to the suite's helpers and does not assert the text, L4 points at the files that hold the admin limit coverage, the entry's position in the registry is fixed, and the effects of a short limit are in the risks. The verifier confirmed by reading that a minimum of 5 is safe, that no migration is needed, that every consumer loops over the registry, and that the worker keeps the uniform rule.

## Review

An independent read-only review on 2026-11-26 approved with no P0, P1 or P2. It confirmed that only an integer from 5 to 230 can reach the timer, that the deadline is still created after the session is claimed, that a response cut during screening is marked and releases its lease, and that every consumer reads the registry. Its three notes are applied: a test that an invalid value of the new variable is named, a comment on why the maximum is 230, and `--stage` in the rollout's Fly commands.
