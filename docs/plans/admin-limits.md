# Admin-tunable budgets and limits

Worktree: `/Users/jonathan/Code/ctf/.worktrees/admin-limits`
Branch: `feature/admin-limits`
Baseline: `2ded8d204e526365d8e244a4d4da0157b174b3b7`. Tracked tree and index clean at start.
Roles: lead Claude Fable 5.2. Plan verifier and code reviewer are independent read-only agents on a high-capability model at high effort. Developer is a medium-capability agent scoped by the lead.
Inventory and asks: https://artifacts.jonathanpollack.dev/a/ajNbFixrF5izjpCd

## Scope

Six values that are constants or inline literals become settings an admin changes at `/admin`. They are stored in the existing `ctf.settings` table. No new migration. Two test and eval migration lists that skip `017-settings.sql` gain it, because admission now reads the table.

| Key                                   | Default    | Bounds                | Unit         | Today                                                  |
| ------------------------------------- | ---------- | --------------------- | ------------ | ------------------------------------------------------ |
| `daily_cap_microdollars`              | 10,000,000 | 0 to 100,000,000      | microdollars | `DAILY_CAP_MICRODOLLARS`, `lib/policy.ts`              |
| `run_budget_microdollars`             | 500,000    | 10,000 to 5,000,000   | microdollars | `RUN_BUDGET_MICRODOLLARS`, `lib/types.ts`              |
| `runs_per_day`                        | 3          | 1 to 50               | count        | `RUNS_PER_DAY`, `lib/types.ts`                         |
| `total_runs_per_day`                  | 100        | 0 to 10,000           | count        | literal `100`, `lib/games.ts` startGame                |
| `monitor_run_allowance_microdollars`  | 1,500,000  | 100,000 to 10,000,000 | microdollars | `MONITOR_RUN_ALLOWANCE_MICRODOLLARS`, `lib/policy.ts`  |
| `final_review_allowance_microdollars` | 1,000,000  | 0 to 10,000,000       | microdollars | `FINAL_REVIEW_ALLOWANCE_MICRODOLLARS`, `lib/policy.ts` |

Bounds are fixed in code. A form typo must not remove the spending limit. The monitor allowance has a positive minimum because at zero every review is refused and no run can be cleared.

## Non-goals

- A weekly cap. None exists today. It is an open ask on the inventory page.
- The other values on the inventory page: environments open at once, name checks per day, reasoning effort, monitor calibration, timing.
- Storing monitor allowances on each run. They stay live, as the constants are today.
- Caching settings. Each admission reads them in its own transaction.
- Refactoring the two existing settings modules. The upsert statement gets a third copy. Extracting it is a follow-up.

## Assumptions and open questions

- The set of six is the lead's recommendation. The user's pick is pending on the inventory page. A value is one registry row plus its enforcement site, so dropping one later is a small revert.
- The existing constants stay where they are and become the defaults. Tests and scripts that import them keep describing default behavior.
- Money is entered at `/admin` in dollars with at most two decimals and stored as an integer string of microdollars.
- A page left open shows the values as of page load. The server enforces the current values. Game rules have the same edge.
- The monitor worker deploys separately from the web app. A worker built before this release keeps the constants. Once redeployed with this release it reads settings live, with no redeploy per change.
- `scripts/flag-read-eval-live.ts` and `scripts/smoke.ts` import the constants and run on freshly migrated databases, where the defaults hold. They are not changed.
- The literal `500000` at `lib/games.ts:687`, `scripts/auth-check.ts:126` and `scripts/monitor-investigate-eval-live.ts:91` is the legacy `token_budget` column, not the run budget. It is not changed.
- Accepted copy edges. The run dialog names the per-member limit from page load, so after an admin lowers the limit during a member's day it can name a number the member did not start. A daily cap of 0 reads "All players share $0 of AI usage a day". The server refusal names the member's real count, see L7.
- Lowering a monitor allowance below what a run under final review has spent ends that run with no result. This follows from applying the allowances live.

## Design

- `lib/limits.ts`: the registry (`LIMITS`: key, default, min, max, kind `money` or `count`), `parseStoredLimit`, and `currentLimits(queryable = db)` returning a `Limits` object. It must not import `lib/auth`, because the monitor worker reads it. It follows `lib/game-rules.ts`. `currentLimits` does not tolerate a missing table: a failed statement would abort the caller's transaction.
- `app/game-ui.tsx` is a client module and bundles `app/run-dialog.tsx` and `app/run-format.ts`. Those three and `app/landing-content.tsx` import only the `Limits` type from `lib/types.ts`, never a runtime value from `lib/limits.ts`, which imports `pg`.
- `Limits` type lives in `lib/types.ts` next to `GameRules`: `dailyCapMicrodollars`, `runBudgetMicrodollars`, `runsPerDay`, `totalRunsPerDay`, `monitorRunAllowanceMicrodollars`, `finalReviewAllowanceMicrodollars`. `DEFAULT_LIMITS` is exported from `lib/limits.ts`.
- `lib/limits-admin.ts`: `limitSettings()` for the changed-by lines and `changeLimit(headers, key, value)`. It follows `lib/game-rules-admin.ts`.
- `app/admin/limits-card.tsx` and a `setLimit` server action in `app/admin/actions.ts`. One form per limit. A refused change redirects to `/admin?limit=refused`, as the model card does.
- Enforcement reads `currentLimits(client)` inside the admission transaction, before the first check that uses a limit. In `startGame` that is before the daily cap check, not beside `currentGameRules`. The sites are: `startGame`, `reserveInference`, `reserveCheck` in `lib/display-name-check.ts`, `assertDispatchAuthorization` in `lib/monitor-classifier.ts`, and the allowance test in `lib/async-finalization.ts`. `newRunsLeft` reads it with `db`.
- `monitorAllowance(status, limits)` and `assertMonitorAllowance(monitorSpent, status, limits)` take the limits as an argument and stay pure.
- Player copy takes a required `limits` prop on `LandingContent`, `GameUI`, `RulesPanel` and `RunSetupNotes`, from the server components that already pass `rules`: `app/page.tsx` and `app/(game)/layout.tsx`. A required prop makes `tsc` catch an unthreaded call site, including `scripts/layout-fixture.tsx` and `tests/monitor-saw.test.ts`. `runsLeftText` takes the per-member limit as an argument.
- The `RUN_BUDGET` string constant in `app/run-format.ts` is replaced by a dollars formatter: whole dollars print without decimals, anything else with two. So 10,000,000 is "$10", 500,000 is "$0.50" and 12,500,000 is "$12.50".
- Dollars from the admin form are parsed from the string, not multiplied as a float: `^\d+(\.\d{1,2})?$`, then whole dollars times 1,000,000 plus cents times 10,000.

## Contract

- L1 Defaults. Given no limit rows, `currentLimits` returns the six defaults, and every existing offline and integration test passes. Changes to existing tests are limited to the new function arguments and props, adding `017-settings.sql` to the migration lists in `scripts/monitor-investigate-eval-live.ts` and `tests/integration/async-backend.test.ts`, and clearing limit rows in the `beforeEach` of `tests/integration/sprites.test.ts`.
- L2 Reader. Given a stored value that is not a canonical non-negative integer string or is outside its bounds, `currentLimits` returns the default for that key and the stored values for the others.
- L3 Authorisation. Given no session, a guest, a guest with the admin flag, or a member, `changeLimit` rejects with `GameError` 404 and stores nothing.
- L4 Validation. Given an admin, `changeLimit` rejects with 400 and stores nothing for an unknown key, a non-string value, an empty or malformed number, a negative number, money with more than two decimals, a count with a decimal part, and a value outside the bounds. Money is accepted as `10`, `0.5` and `0.50` and refused as `.5`, `10.` and `1e1`. `2.01` stores `2010000` and `0.5` stores `500000`. An accepted value is stored as an integer string with `updated_by` and `updated_at`. A second change replaces the row. `limitSettings` reports who and when.
- L5 Daily cap. Given a day's spend at the stored cap, a new run, an agent or monitor reservation, a name check and a classifier dispatch are each refused with their existing status and message, and no hold is left. A cap of 0 refuses all of them. Given the day's spend at the default cap and a stored cap above it, a new run starts, an agent reservation and a name check are admitted, and `runMonitorWorkerOnce` sends a classifier request. The raised direction is required because the classifier dispatch check is followed by a reservation that refuses with the same status and text.
- L6 Run budget. A run started after a change has `budget_microdollars` equal to the stored value. A run that already exists keeps its own.
- L7 Runs per member. `runsLeft` from `GET /api/games` and admission in `POST /api/games` follow the stored value. The server refusal names the number of runs the member started, with "1 new run" in the singular. Admins stay exempt.
- L8 Total runs. Given a stored total equal to the number of new runs in the last 24 hours, the next start is refused with 429 "No more new runs can start right now. Try again later." and a start below it is admitted.
- L9 Monitor allowances. A monitor reservation is refused with 402 at the stored run allowance while the run is active, and at the stored run allowance plus the stored final review allowance while it is finalizing. It is admitted one microdollar below each. Given an active run with settled monitor spend at the default run allowance and a stored run allowance above it, `runMonitorWorkerOnce` sends a classifier request. Given a finalizing run with settled monitor spend at the default run plus final sum and a stored final review allowance above its default, it sends one too. The finalization decision that ends a run for an exhausted allowance uses the same stored sum.
- L10 Admin card. `/admin` shows a "Budgets and limits" card with one labelled field per limit, its current value in dollars or as a count, its bounds as `min` and `max`, a submit button and the changed-by line. A refused change shows a fixed alert. The server action authorises inside the lib call.
- L11 Player copy. The landing page, the rules panel and the run dialog show the stored run budget, runs per member and daily cap. At the defaults the rendered strings are unchanged: "$0.50", "3 new runs every 24 hours", "$10 of AI usage a day". A cap of 12,500,000 reads "$12.50". A value of 1 reads "1 new run". No module under `app/` imports `RUN_BUDGET`, `RUNS_PER_DAY` or `RUN_BUDGET_MICRODOLLARS`.
- L12 Docs. `deploy/operations.md` (the administrator section and the capacity table) and `README.md` state the six values as defaults an admin can change, that the worker reads them live once it runs this release, and that lowering a monitor allowance can end runs under final review with no result.

## Criterion to check

| Criterion  | Check                                                                                                                                                                                                                                                                                                            | Status                                                                                      |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| L1         | `npm run check`; `npm run test:integration`                                                                                                                                                                                                                                                                      | passed                                                                                      |
| L2, L3, L4 | new `tests/integration/limits.test.ts`, modelled on `tests/integration/agent-model.test.ts`; `parseStoredLimit` cases in a new offline `tests/limits.test.ts`                                                                                                                                                    | passed                                                                                      |
| L5         | reservation and worker cases in `tests/integration/sprites.test.ts` next to "A3-4 and A3-5" and "B3"; name-check case in `tests/integration/display-name.test.ts`                                                                                                                                                | passed                                                                                      |
| L6, L7, L8 | cases in `tests/integration/sprites.test.ts` next to "personal run quota", through the real `GET` and `POST /api/games` routes                                                                                                                                                                                   | passed                                                                                      |
| L9         | `tests/game.test.ts` for the pure function; stored-value case in `tests/integration/sprites.test.ts` next to "A3-4 and A3-5" and the finalization allowance tests                                                                                                                                                | passed                                                                                      |
| L10        | new offline `tests/admin-limits-card.test.ts`, modelled on `tests/admin-agent-model.test.ts`, proves the card. The wiring in `app/admin/actions.ts` and `app/admin/page.tsx` is proven by reading the diff and by the browser check in step 10. If step 10 is unrun, the wiring is reported as read, not tested. | passed                                                                                      |
| L11        | `tests/run-dialog.test.ts`, `tests/copy-cleanup.test.ts`, `tests/landing.test.ts`, `tests/game-rules-copy.test.ts` with default and non-default limits; `tsc` for the required props; `grep -rnE 'RUN_BUDGET                                                                                                     | RUNS_PER_DAY' app`returns nothing; read the diff of`app/page.tsx`and`app/(game)/layout.tsx` | passed |
| L12        | read the diff                                                                                                                                                                                                                                                                                                    | passed                                                                                      |

Integration prerequisites: Docker running, images `postgres:18-alpine` and `ctf-flag-read-sprite:1` present. Both are present on this machine.

## Steps

1. Independent read-only plan review. Resolve blocking findings.
2. Red: add `tests/limits.test.ts` and `tests/integration/limits.test.ts`. Run them and record the failure for the missing module.
3. Add `lib/limits.ts`, the `Limits` type and `lib/limits-admin.ts`. Verify step 2 passes.
4. Red: add the L5 to L9 integration cases with stored values that differ from the defaults. Record that they fail because enforcement still reads constants. The `beforeEach` in `tests/integration/sprites.test.ts` deletes the six limit keys from `ctf.settings`, so a failed case cannot leak a limit into later cases. The name-check case in `tests/integration/display-name.test.ts` removes its limit row in `finally`.
5. Thread `currentLimits` through the enforcement sites. Verify step 4 and the untouched neighbours pass.
6. Red then green: admin card test, card, action, page wiring.
7. Red then green: copy tests with non-default limits, then the `limits` prop and formatter.
8. Docs.
9. `npm run check`, `npm run test:integration`, `npm run build` with synthetic environment values as CI does. The lead inspects raw output.
10. Browser check of `/admin` and the rules panel if a local database is available without touching shared data. Otherwise report it unrun.
11. Independent full-delta review. One corrective cycle at most. The reviewer confirms `lib/limits.ts` imports only `db`, `policy` and `types`, and that `lib/limits-admin.ts` is imported only under `app/admin`.

No merge, push or deploy. No shared database, paid service or `.env.local` credentials in tests.

## Evidence

- Plan review, 2026-11-25 UTC: approved with changes. Re-review of the revision approved with two further P2 changes, also folded in (L9 run status, L4 one-decimal case). One P1 (test and eval databases without the settings table) and six P2 findings are folded in above.
- Stage A (L1 to L9), 2026-11-25 UTC. Red first: `tests/limits.test.ts` and `tests/integration/limits.test.ts` failed on the missing module. The 14 new L5 to L9 cases failed against unchanged enforcement, for example `500000 !== 250000` for L6, `200 !== 429` for L8, and "the classifier was asked" false for the raised-cap worker case. Green after implementation.
- Lead run after stage A: `npm run check` passed with 528 offline tests. `npm run test:integration` passed with 587 tests, log `/tmp/admin-limits-integration-a.log`. No test database other than the two named in L1 lacked `ctf.settings`.
- Not committed. The user's standing rule is to commit only when asked, so there are no checkpoint commits.
- Stage B (L10 to L12), 2026-11-25 UTC. Red first: `tests/admin-limits-card.test.ts` failed on the missing module, `tests/copy-cleanup.test.ts` on the removed `RUN_BUDGET` export, and the two singular run-dialog cases read "3 new runs" where "1 new run" was expected. The `dollars` and `newRuns` formatter cases were written after the helpers, so they have no red run.
- Lead run after stage B: `npm run check` passed with 537 offline tests, log `/tmp/admin-limits-check-b.log`. `npm run test:integration` passed with 587 tests, log `/tmp/admin-limits-integration-b.log`. `grep -rnE 'RUN_BUDGET|RUNS_PER_DAY' app` prints nothing.
- Browser check, step 10. Next dev ran against a disposable local Postgres with TLS and synthetic credentials. The shared development database was not used. A synthetic admin signed in by a magic link captured in-process. `/admin` showed the card with six fields at their defaults. Saving 12.5 for the daily cap stored `daily_cap_microdollars|12500000` with that admin's id and showed the changed-by line. An out-of-range run budget of 500, sent with the field's `min` and `max` removed, redirected to `/admin?limit=refused`, showed the alert and stored nothing. The rules panel then read "All players share $12.50 of AI usage a day." and the landing page kept "$0.50 AI budget per run · 3 new runs every 24 hours". Screenshots hung in this environment, so layout was measured from element rectangles.
- Layout fix after the browser check: each limit row reuses the `.rule` row, with three new CSS rules under `.limit`. Re-measured in the browser: all six inputs share one left edge and width, hints and the changed-by line stack under the label, and the card does not overflow.
- Final lead run: `npm run check` passed with 537 offline tests, log `/tmp/admin-limits-check-final.log`. `npm run build` with the CI environment values exited 0, log `/tmp/admin-limits-build.log`. Next also loaded the worktree's `.env.local` during the build, so it is not a strict copy of the CI build. The integration suite was last run after stage B and before the layout fix and a README wording change, neither of which an integration test imports.
- Independent full-delta review: approved, no P0 to P2 findings. P3 notes left as they are:
  - The client receives all six values, including the total run count and both monitor allowances, which no player copy uses.
  - The plural rule for "new run" exists in both `lib/games.ts` and `app/run-format.ts`.
  - The monitor-reservation daily cap case asserts the status and not the message.
  - The card test checks the range hint loosely. The `min` and `max` attributes are checked exactly.
  - The L2 cleanup in `tests/integration/limits.test.ts` is not in a `finally`.
  - The card rounds a stored value that is not a whole number of cents, which only a hand edit can create.
- The reviewer's README finding is fixed: the link now points at the operations guide without a section anchor.
- Disposable browser-check database, certificates and scripts are removed.

## Decisions from the user, 2026-11-25

- The six values are approved.
- No weekly cap.
- Commit, push and open a pull request for this work. Nothing is merged.
- A second phase is requested and is not part of this contract yet: the remaining values from the inventory, reasoning effort for the attacker and the investigator, a limit on sessions per run, an environment-variable fallback for every value, and a deploy check that those variables are set. Parallel runs per member were raised as a possibility.
