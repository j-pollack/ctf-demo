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

# Phase 2: more settings, environment fallback and a deploy check

Requested by the user on 2026-11-25 after phase 1. Same worktree and branch. Phase 1 is staged in the index and not committed, because the commit command was refused by the session's permission classifier. Phase 2 changes stay unstaged until the lead verifies them, so the two phases can be told apart.

## Scope

Six more registry entries, for twelve in total.

| Key                   | Default | Allowed           | Kind   | Today                                                |
| --------------------- | ------- | ----------------- | ------ | ---------------------------------------------------- |
| `environments_open`   | 10      | 1 to 50           | count  | literal `10` in `startGame`                          |
| `name_checks_per_day` | 20      | 1 to 200          | count  | `NAME_CHECKS_PER_DAY`, `lib/display-name-check.ts`   |
| `sessions_per_run`    | 8       | 1 to 32           | count  | new. A run has no session limit today.               |
| `auto_continue_turns` | 8       | 0 to 50           | count  | `AUTO_CONTINUE_MAX`, `app/game-ui.tsx`, browser only |
| `agent_effort`        | low     | low, medium, high | choice | `PLAYER_AGENT_EFFORT`, `lib/policy.ts`               |
| `investigator_effort` | high    | low, medium, high | choice | `INVESTIGATOR_EFFORT`, `lib/investigator-driver.ts`  |

Also in scope:

- An environment layer under the stored settings. Each key reads `CTF_<KEY IN UPPER CASE>`, for example `CTF_DAILY_CAP_MICRODOLLARS` and `CTF_AGENT_EFFORT`, in the stored format: whole microdollars, a whole count, or an effort word.
- A deploy check that refuses a deploy when any of the twelve variables is missing or invalid.
- The browser receives only the values player copy and the play UI use.

## Non-goals

- Parallel runs per member. Starting a run ends the member's open run today, and the play UI, the games route and cleanup all assume one open run. It is a feature, not a setting. The user agreed on 2026-11-25 to leave it out.
- The jailbreak thresholds and the investigator model. Both change what the monitor decides under an unchanged version stamp. The user agreed on 2026-11-25 to leave both in code because the eval results were measured at those values.
- Environment fallbacks for the attacker model and the three game rules, which predate this work.
- Recovering admission when the database is down. Admission stores runs and spend holds in the database, so no fallback can admit a request without it.

## Assumptions and open questions

- Resolution order per key: a valid stored value, then a valid environment value, then the code default. The code default stays so tests, scripts and local development need no environment.
- The fallback cannot keep the game playable when the database is down. Every API route signs the member in through the same database, and admission stores runs and holds there. What it can do is let the landing page and the rules page render. For that, only the two page components catch a rejected read, and they use environment and default values in its place. Routes, the admin page, `newRunsLeft` and the worker do not catch, so none of them acts on fallback values silently. With a real outage the page waits for the pool's 10 second connection timeout first. Inside a transaction the error propagates, as in phase 1.
- The environment layer also supplies a deploy-level default whenever a row is absent or invalid.
- The web app reads its variables from Vercel and the worker from Fly. With no stored row the two can differ if the variables differ.
- The default of 8 sessions per run is the lead's choice. A run that already has more keeps them and cannot add another.
- The investigator's effort is monitor calibration. The user asked for it. Each review records the effort it ran with, so results under different efforts can be told apart in the database. The leaderboard filters on the monitor version and the three rules only, so it ranks wins under different efforts together. The evals in the repo describe "high" only.
- Fly secret values cannot be read from a workflow. The worker deploy check proves the twelve names are set on the Fly app. The Vercel check proves names and values. A worker with an invalid value uses the code default for that key.
- Whether the two Fly deploy tokens may list secrets is unconfirmed. The first real run of the worker check is the production workflow.
- A manual `flyctl deploy` and a Vercel promote or rollback of an existing build pass through no check.
- After this merges, a Vercel deploy and a worker deploy fail until the twelve variables are set in Vercel Production and Preview and on both Fly apps. The pull request's own preview fails the same way.
- The Sprites account's own limit is the real ceiling for `environments_open`. It was not checked.

## Design

- `lib/limits.ts`: the registry gains kind `choice` with `options`. `Limits` gains `environmentsOpen`, `nameChecksPerDay`, `sessionsPerRun`, `autoContinueTurns`, `agentEffort` and `investigatorEffort`. New exports: `limitEnvName(key)`, `limitEnvProblems(env)` returning the missing and the invalid variable names, `playerLimits(limits)`, and the `PlayerLimits` type in `lib/types.ts` holding `runBudgetMicrodollars`, `runsPerDay`, `dailyCapMicrodollars`, `sessionsPerRun` and `autoContinueTurns`.
- `currentLimits` and `currentGameRules` never catch. `lib/limits.ts` exports `fallbackLimits(env)`, the environment and default values with no database read. A new `app/page-settings.ts` exports `pageSettings()`, which returns the rules and the player limits for a page. On a rejected read it logs one JSON line to `console.error`, with event `limits_read_failed` or `game_rules_read_failed`, and returns `playerLimits(fallbackLimits(process.env))` or `DEFAULT_GAME_RULES`. `app/page.tsx` and `app/(game)/layout.tsx` are its only callers.
- `process.env` is read when a function is called, not when the module loads.
- `lib/limits.ts` still imports only `db`, `policy` and `types`. `INVESTIGATOR_EFFORT` moves to `lib/policy.ts` beside `INVESTIGATOR_MODEL`, and `lib/investigator-driver.ts` re-exports it as it does the model. Importing it from the driver would create a cycle through `lib/inference.ts` and `lib/games.ts`.
- `changeLimit` accepts a choice value only when it is one of the options.
- Client components take `PlayerLimits`, not `Limits`.
- Attacker effort follows the attacker model's path: `publicAgentSettings` takes the current effort, and the games, sessions and prompt routes pass `(await currentLimits()).agentEffort`. A client that sends a different effort is still refused.
- Investigator effort: the worker reads the limits once per review and passes the effort down every path that sends an investigator-model request. There are two request sites, `lib/investigator-driver.ts` and `lib/second-look-run.ts`, and three paths to them: the investigation, the worker's direct second look, and the decoded-layer second look through `createDecodedScreen` in `lib/decode-screen.ts`. The effort travels in `RunMonitorReviewInput` and the arguments of `createDecodedScreen` and `runSecondLooks`, each defaulting to the constant, so evals and scripts stay on "high". `FlagReadInvestigationResult.investigatorEffort` returns the effort used and is typed `AgentEffort`.
- Migration `035-review-effort.sql` adds a nullable `investigator_effort text` to `ctf.monitor_reviews`. The worker writes it in the INSERT that creates the review row in `lib/monitor-worker.ts`, beside `model` and `prompt_version`, so failed and deferred reviews record it too. The migration joins `scripts/setup.ts`, `MIGRATIONS` in `scripts/monitor-investigate-eval-live.ts`, the lists in `tests/integration/async-backend.test.ts`, `sprites.test.ts`, `flag-submission-runner.test.ts`, `flag-submission-route.test.ts` and `flag-submission.test.ts`, and the migration table in `deploy/operations.md`.
- Sessions per run: `createSession` counts the run's sessions inside its transaction, after it locks the run. The refusal is 429, as the other quotas in `lib/games.ts` are.
- Auto-continue has two sites in `app/game-ui.tsx`: the check before sending "Continue." and the line that stops further auto-continues after a failed send by setting the counter to the maximum. The second sets it to `Infinity`.
- `scripts/vercel-build.ts` exports a pure `deployEnvProblems(env)`, which returns `limitEnvProblems(env)` when `VERCEL_ENV` is `production` or `preview` and nothing otherwise. The script calls it first and throws naming every problem before it migrates or builds.
- `scripts/check-limit-env.ts`: reads text on stdin, splits it on every character outside `[A-Z0-9_]`, and exits 1 naming each of the twelve variable names that is not a whole token. Empty input fails. `migrate-prod.yml` and `preview-worker.yml` pipe plain `flyctl secrets list --app <app>` into it, after "Install locked dependencies" and before the drain step, so a failure leaves the running worker untouched. No `jq`: the JSON field names of that command could not be confirmed.
- The admin card shows all twelve. A choice renders as a `<select>`. The investigator effort row carries one line of warning: the leaderboard does not separate wins by investigator effort.

## Contract

- M1 Registry. Given no rows and no environment, `currentLimits` returns the twelve defaults. A stored choice outside its options gives the fallback for that key only.
- M2 Environment layer. A valid stored value wins over the environment. With no stored value, or an invalid one, a valid environment value is used. An invalid or absent environment value gives the code default. `limitEnvProblems` lists each missing and each invalid name and is empty when all twelve are valid.
- M3 Database failure. Given a settings table that cannot be read, the landing page component and the game layout both return elements carrying the environment values and the default rules, and `limits_read_failed` and `game_rules_read_failed` are logged to `console.error`. `currentLimits()` and `currentGameRules()` themselves reject.
- M4 Environments. A start is refused with 429 "All environments are busy. Try again in a few minutes." at the stored count and admitted below it.
- M5 Name checks. A member is refused with the existing 429 text at the stored count and admitted below it.
- M6 Sessions per run. `POST /api/games/:id/sessions` is refused with 429 and "This run has N sessions and cannot add another." when the run has the stored count or more, with "1 session" in the singular, and stores nothing. It is admitted below the count. The Add session control is disabled at the limit and says why.
- M7 Auto-continue. The play UI stops auto-continuing after the stored number of turns. Zero disables it.
- M8 Attacker effort. A run started after a change, and a session's next instruction, use the stored effort: `agent_sessions.agent_effort` holds it and the agent request body's `reasoning.effort` carries it. A request that names a different effort is refused with the existing 400 text.
- M9 Investigator effort. With a stored effort, the investigator's requests, the worker's second look requests and the decoded-layer second look requests carry it, and the review row records it, including a review that fails. With none, they carry the default and the row records the default.
- M10 Admin card. All twelve appear. Efforts are selects with the current option selected. `changeLimit` refuses an unknown option with 400 and stores nothing.
- M11 Browser exposure. `GameUI`, `RulesPanel`, `RunSetupNotes` and `LandingContent` take `PlayerLimits`. The elements returned by the page component in `app/page.tsx` and the layout in `app/(game)/layout.tsx` carry a `limits` prop with exactly the five keys.
- M12 Deploy check. With `VERCEL_ENV` of `production` or `preview` and a variable missing or invalid, the Vercel build script fails before migrating or building and names it. With all twelve valid it proceeds to the next step. With `VERCEL_ENV` unset it does not check. `scripts/check-limit-env.ts` exits 1 naming absent names, treats `CTF_RUNS_PER_DAY` inside `CTF_TOTAL_RUNS_PER_DAY` as absent, fails on empty input, and exits 0 when all twelve are present. Both worker workflows run it before the drain. `.env.example` lists the twelve with their defaults and passes `limitEnvProblems`.
- M13 Docs. `deploy/operations.md` gives the variable names, the resolution order, what the fallback covers and does not cover, the commands to set the variables on Vercel and Fly, the deploy check and what bypasses it, that web and worker can differ, that the leaderboard does not separate investigator efforts, and migration 035. The capacity table and the README name the new limits, and the sentence that excepts the ten environments is corrected.

## Criterion to check

| Criterion  | Check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Status |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| M1, M2, M3 | offline `tests/limits.test.ts` for parsing, resolution and `limitEnvProblems`; `tests/integration/limits.test.ts` for stored, environment and default precedence, and for M3 by renaming `ctf.settings`, setting a non-default `CTF_RUN_BUDGET_MICRODOLLARS`, calling `Home()` and `GameLayout()` and both readers, then restoring the table and the environment in `finally`                                                                                                                                                                                                                              | passed |
| M4, M6, M8 | `tests/integration/sprites.test.ts` through the real routes; M6's control in `tests/session-chips.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | passed |
| M5         | `tests/integration/display-name.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | passed |
| M7         | offline test of `shouldAutoContinue` with a stored maximum; read the diff of its call sites                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | passed |
| M9         | `tests/integration/sprites.test.ts`: the OpenRouter fake's captured request bodies carry the effort on all three paths, with the decoded-layer case next to the B3 tests, and the review row holds it; migration applied twice                                                                                                                                                                                                                                                                                                                                                                             | passed |
| M10        | `tests/admin-limits-card.test.ts`; `tests/integration/limits.test.ts` for the choice validation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | passed |
| M11        | `tests/integration/limits.test.ts` calls `Home()` and `GameLayout()` and asserts the keys of the `limits` prop                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | passed |
| M12        | `tests/vercel-build.test.ts` tests the pure `deployEnvProblems` for unset, development, preview and production, and runs `scripts/vercel-build.ts` as a subprocess with `VERCEL_ENV=preview` and no database URL: with variables missing the error names them, and with all twelve valid it fails on the missing database URL, which proves the check ran first and passed. New offline test runs `scripts/check-limit-env.ts` as a subprocess. Offline test that `.env.example` passes `limitEnvProblems`. Read the workflow diff. The `flyctl` glue cannot run here and is reported as read, not tested. | passed |
| M13        | read the diff                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | passed |
| All        | `npm run check`; `npm run test:integration`; `npm run build`; browser check of the card on a disposable database                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | passed |

## Steps

1. Independent read-only plan review of phase 2.
2. Stage C, red then green: registry, environment layer, database-failure fallback, `limitEnvProblems`, `playerLimits`, deploy check scripts and workflow steps, `.env.example`.
3. Stage D, red then green: enforcement for environments, name checks, sessions per run, attacker effort, investigator effort with migration 035.
4. Stage E, red then green: admin card, `PlayerLimits` props, auto-continue, Add session control, copy, docs.
5. Lead verification: `npm run check`, `npm run test:integration`, `npm run build`, browser check.
6. Independent review of the phase 2 delta. One corrective cycle at most.

No merge, push or deploy. No shared database, paid service or `.env.local` credentials in tests. No Vercel or Fly settings are changed by this work.

## Phase 2 evidence

- Plan review, 2026-11-25 UTC: approved with changes. Two P1 findings (an import cycle through the investigator driver, and the migration lists and write site for the effort column) and eight P2 findings are folded in above. Re-review approved with two further P2 changes, also folded in: the fallback catch is confined to the two page components, and the unset and production cases of the Vercel check are proven through a pure function.
- Stages C and D, 2026-11-25 UTC. Red first: `tests/limits.test.ts` failed on the missing `fallbackLimits` export, `tests/vercel-build.test.ts` on the missing `deployEnvProblems`, `tests/check-limit-env.test.ts` on the missing `limitEnvName`. Eleven enforcement cases failed against unchanged code, for example `200 !== 429` for M6 and M8's refusal, a null `investigator_effort` for M9, and a request at `high` where `low` was stored.
- Stage E. Red first: seven of eight rewritten card cases, the session limit case in `tests/session-chips.test.ts`, and the M3 and M11 page cases, which stayed red from stage C until the pages switched to `pageSettings()`. No red run exists for the rules-panel session sentence, for the `shouldAutoContinue` maximum and zero cases, which the function already supported, or for a run-console threading case written after the plumbing.
- Lead run after stage E: `npm run check` passed with 561 offline tests, log `/tmp/admin-limits-p2-check.log`. `npm run test:integration` passed with 601 tests, log `/tmp/admin-limits-p2-integration.log`. `npm run build` with the CI values exited 0, log `/tmp/admin-limits-p2-build.log`. Next also loaded the worktree's `.env.local` during the build.
- Browser check on a disposable local Postgres with TLS, synthetic credentials and `CTF_RUN_BUDGET_MICRODOLLARS=750000` in the environment. The shared development database was not used. `/admin` showed twelve rows with aligned controls and no overflow. The run budget field read 0.75 with no stored row, and the landing page read "$0.75 AI budget per run", so the environment layer works in the running server. Saving `medium` for the investigator effort stored `investigator_effort|medium` and showed the changed-by line. A forged option `extreme` for the attacker effort redirected to `/admin?limit=refused`, showed the alert and stored nothing. The rules panel read "A run can have up to 8 sessions." The HTML of `/rules` contained the five player keys and none of the other seven.
- Not run: the `flyctl secrets list` workflow steps, and the `vercel env add` and `flyctl secrets set` commands in the operations guide. Their syntax was checked against each tool's `--help` only. The disabled Add session control was not seen in a browser, because starting a run needs the Sprites service. It is covered by `tests/session-chips.test.ts`.
- Disposable browser-check database, certificates and scripts are removed.
- Independent review of the phase 2 delta: no P0 or P1. One P2: on a failed settings read the game layout handed the play UI fallback values, so a tab could auto-continue after an admin had stored zero. One corrective cycle fixed it and six P3 notes:
  - The page fallback forces auto-continue off, and the operations guide names every page under the game layout.
  - A click on Add session at the limit shows the reason in the play UI's existing alert and sends no request.
  - The session refusal text has one source in `lib/types.ts`.
  - A new case sends six parallel creates against a limit of 4 and sees three admitted and three refused.
  - Both workflow steps capture the `flyctl` output before the scan, so a `flyctl` failure does not print twelve false names.
  - Two assertions that proved nothing are removed.
  - The guide says deploys fail until the variables are set.
- Re-review after the corrective cycle: approved, no P0 to P2 anywhere in phase 2. Two P3 notes left as they are: the early return in the play UI's `createSession` is proven by reading and by the pure helper's test, and the chip and that function count sessions from two views of the same run, where the server's count decides.
- Final lead run after the corrective cycle: `npm run check` passed with 561 offline tests, `npm run test:integration` passed with 602 tests, and `npm run build` with the CI values exited 0. Logs are `/tmp/admin-limits-p2c-check.log`, `/tmp/admin-limits-p2c-integration.log` and `/tmp/admin-limits-p2c-build.log`. The browser check predates the corrective cycle, so the click on Add session at the limit was not seen in a browser.
- Not committed. Phase 1 is staged and phase 2 is unstaged. The commit command was refused by the session's permission classifier.
- After the pull request opened, at the user's request: the session refusal reads "This run has the maximum number of sessions. You cannot add more." in place of the wording in M6, and the Save buttons on the admin cards show "Saving…" and are disabled while the action runs.
