# UI cleanup: stale copy, admin attacker model, monitor catch-up

Worktree: `/Users/jonathan/Code/ctf/.worktrees/ui-cleanup`
Branch: `feature/ui-cleanup`
Baseline: `2681c0cd6a826cddd3ff6f2440bab3bcf75c637f`; clean index and worktree. Primary checkout stays unchanged.

Roles: lead is Claude Fable 5.2. Plan verifier and code reviewer are independent Claude Opus agents at high reasoning effort, read-only. Developers are Claude Sonnet agents at medium reasoning effort.

## Scope

Three workstreams from one request.

1. **Copy.** Player and admin text still describes mechanics that were removed. Correct it, and remove the leftover controls for those mechanics.
2. **Attacker model.** An admin can change the player agent model from `/admin`. Today it is the constant `AGENT_MODEL` in `lib/policy.ts`.
3. **Monitor catch-up.** The user reported slow catch-up and a confusing review status line. Fix the claim ordering that starves later sessions, and rewrite the status line.

## Investigation findings for workstream 3

The queue already coalesces updates. `ctf.monitor_jobs` holds one row per `(session_id, epoch)`. Every transcript append upserts `requested_version` on that row (`lib/monitor-jobs.ts:19`). A claim fixes `target_version`, the worker reconstructs the whole transcript at that version and reviews it once (`lib/monitor-worker.ts:31`). Appends that land during a review leave the job `queued`, and the next review covers all of them. `tests/integration/async-backend.test.ts:438` already proves this. No per-update queue items exist to clear.

Two causes of slow catch-up were found by reading the code. Neither has been measured in production.

- **Claim ordering starves sessions.** Within a run, `claimMonitorJob` picks the ready job with the oldest `created_at` (`lib/monitor-jobs.ts:103`). A session whose agent keeps appending is requeued after each review and is still the oldest job, so it is claimed again. A later session in the same run waits until the first goes quiet. Across runs, candidates are ordered by `next_attempt_at`, which an append with a higher version resets to `now()` unless the job is under review (`lib/monitor-jobs.ts:36`), so a queued job that keeps receiving appends sorts behind jobs that append less often.
- **One serial worker.** `scripts/monitor-worker.ts` runs one review at a time for all runs. The investigator deadline is 90 seconds inside a 120-second claim (`lib/investigator-evaluation-policy.ts`).

The status line reads `{reviewedUpdates} of {totalUpdates} transcript updates reviewed · {pendingSessions} sessions pending` (`app/game-ui.tsx:1776`). The unit is internal observation versions. The numerator jumps because one review covers many versions. The numerator counts `reviewed_version` while the pending count uses `covered_version`, so an inconclusive review can show every update reviewed and a session still pending. `1 sessions` is ungrammatical.

## Non-goals

- Worker concurrency, debouncing reviews until a turn goes idle, and LISTEN/NOTIFY in place of the one-second poll. Each is a separate decision for the user. See open questions.
- Removing `monitor_difficulty` from the database, the API parameters, the classifier profile, or `PublicGame`. Difficulty stays as stored history and as the classifier profile. Only its player-facing surface goes.
- Removing the leaderboard agent-model filter. Workstream 2 makes it meaningful again.
- Removing `reviewedUpdates` and `totalUpdates` from the API response.
- Per-run or per-player model choice. The setting is global.
- Fork modal copy, which is unreachable while `FORKING_ENABLED` is false.

## Assumptions

- A1. The admin setting replaces the constant wherever a player request is pinned to `AGENT_MODEL` today: the four routes that call `publicAgentSettings`. `claimSession` already writes the pinned model onto the session at every instruction (`lib/sessions.ts:348`). A model change therefore applies to the next instruction of every session, including runs in progress. This matches what a deploy that edits the constant does today.
- A2. Selectable models are the existing `MODELS` allowlist in `lib/policy.ts`. No free-text model ids.
- A3. The setting is read from Postgres on each request, with no cache. The app runs on several serverless instances and a cache would serve stale values.
- A4. Migration `017` is additive, so the `migrate prod` workflow can apply it while old code serves.

## Criteria

### Copy

- **C1.** Given the landing page, the Rules panel, the run history row and the leaderboard, when rendered, then none of them mention a difficulty, `Easy`, `Medium` or `Hard`. The leaderboard has no difficulty select and its request carries no `difficulty` parameter. `DIFFICULTY_CHOICES`, `boardDifficulty` and the unused `MONITOR_DIFFICULTIES` import are gone from `app/game-ui.tsx`.
- **C2.** The following strings read as specified.
  - `app/page.tsx` step 2: "Press **Play** and start a run. The run gets one computer and one flag. Its sessions share both."
  - `app/page.tsx` step 3, last sentence: "The investigator can review these instructions. It can also review transcripts from your other sessions and runs."
  - `app/page.tsx` step 5, last sentence ends "does not count as a detected read."
  - `app/page.tsx` small print: "Sign in to play · $0.50 AI budget per run · 3 new runs a day"
  - `CAUGHT_NOTICE`: "The investigator found evidence that an agent read the flag. This run has ended."
  - Glossary entry Caught: "The investigator found evidence that an agent read the flag and ended the run. It is a loss."
  - Glossary entry Suspicion is renamed "Risk score": "A classifier estimate from 0% to 100%. It is advisory. The investigator reviews transcript evidence separately."
  - Rules budget sentence: "Agent, classifier and investigator calls all use this budget."
  - Rules bug-test sentence: "The game runs all four bug tests and needs at least one to pass before confirming a win."
  - Rules heading "What the monitor sees" becomes "What the investigator sees".
  - Leaderboard empty state: "No verified wins yet."
  - Leaderboard footnote: "Each player’s cheapest win. If two cost the same, fewer turns ranks higher. Names are anonymous." The sentence about picking an agent model stays after it.
  - Rules leaderboard sentence: "Each player’s cheapest verified win, cheapest first. If two wins cost the same, fewer turns ranks higher. Names are anonymous."
  - Rules closing line: "Nobody may have won yet. That does not mean a win is impossible."
- **C3.** The leaderboard table has no Findings column and no Reasoning column. The history row has no "investigator findings" segment. The `Score` type drops `blocks` and `monitor_reasoning`.
- **C4.** Admin: "Monitor block rate" reads "Catches per turn". The capture-rate card note reads "By classifier model and recorded difficulty. New runs all record hard." README "Game rules" bullets match current behavior: the model is fixed for players and set by an admin, players do not choose a difficulty, blocking applies to legacy runs only, the leaderboard is not per difficulty, and forking is disabled in the player UI.

### Attacker model

- **A1.** Given no stored setting, the effective model is `AGENT_MODEL`. Given a stored value that is not in `MODELS`, the effective model is `AGENT_MODEL`.
- **A2.** Given a signed-in admin, when they submit a model that is in `MODELS` and that `getModel` accepts, then the setting row holds that model, the admin's user id and the time. `/admin` shows a card with a select of `MODELS`, the current model selected, and who changed it and when.
- **A3.** Given a request with no session, an anonymous session, or a member without the admin flag, when it submits a model, then it is refused and no row changes. Given an admin submitting a missing value, a non-string value, a value outside `MODELS`, or a model `getModel` rejects, then it is refused and no row changes. After a refusal the action redirects to `/admin?model=refused` and the card shows the fixed text "That model was not saved. It must be on the allowlist and served by the catalog." The page never renders text taken from the query string. Errors that are not `GameError` are logged with `console.error` and get the same redirect.
- **A4.** Given the setting was changed to model M, when a player starts a run through `POST /api/games`, then `ctf.games.agent_model` and the first session's `agent_model` are M. When a player sends an instruction to a session created under the old model, that session's `agent_model` becomes M. A request body that names any model other than M is refused with 400 "The agent model cannot be changed."
- **A5.** `db/migrations/017-settings.sql` is idempotent, additive, and listed in `scripts/setup.ts`. Applying it twice succeeds.
- **A6.** The monitor worker still starts without web credentials. `lib/admin.ts` gains no imports. Nothing reachable from `lib/monitor-worker.ts` imports the new `lib/agent-model.ts`.

### Monitor

- **M1.** Given one run with two sessions whose jobs are both ready, where the older job was reviewed most recently and has newer appends, when the worker claims, then it claims the other session's job. Given two runs in the same state, the same holds across runs. Jobs are ranked by when they last got attention: `last_reviewed_at`, or `created_at` for a job that has never been reviewed. The oldest goes first. Ties fall back to `created_at`, then `id`. A waiting never-reviewed job therefore goes ahead of a job reviewed after it was created, and a job created after another job's last review does not go ahead of it. The second half closes a queue jump: with never-reviewed jobs always first, a player could open fresh sessions to push back the review of an earlier session.
- **M1a.** Given a queued job whose `last_reviewed_at` is older than every other job's and whose `next_attempt_at` is a minute ahead, and a second ready job, when the worker claims, then the second job is the one claimed. The test sets both columns with SQL and does not rely on real backoff timing.
- **M1b.** Given a job whose claim expires three times, when the worker claims again, then the job is `unresolved` with reason "Review stopped before its outcome was verified." A newer append requeues it. The test reads the job's row, because the claim call that marks it `unresolved` returns null or a different job.
- **M2.** The review status line comes from an exported pure function of the monitor status, `pendingSessions` and the session count. The session count is `displayGame.sessions.length` inside `app/game-ui.tsx`; no API field is added. The function returns:
  - `caught-up`: "All sessions reviewed."
  - `queued` or `reviewing`: "{n} of {total} sessions waiting for review."
  - `unresolved`: "{n} of {total} sessions not fully reviewed."
  - any status other than `caught-up` with no pending sessions: no line. A run can be `unresolved` because of a scoring failure or an uncertain command while every session is reviewed, and the reason line already says so.
  - `caught`: no line.
  - "session" is singular when total is 1. The line no longer shows update counts. The status label, last review time and reason are unchanged.

### Difficulty parameter

Added after the first review, at the user's request.

- **D1.** Given a `POST /api/games` request or a prompt request whose body carries `monitorDifficulty` with a valid value, an unknown value or a non-string, then the request is handled as if the field were absent. It is not refused on that field's account. A new run records `hard`. An existing run's stored difficulty does not change. The neighbouring field is still validated: a body with `monitorReasoning: null` is refused with 400, takes no lease and runs nothing.
- **D2.** `GET /api/leaderboard` does not read `difficulty`. With any value, or none, it returns the board for runs recorded as `hard` under the current monitor version. A captured run recorded as `easy` under the current version does not appear, whether the request sends `difficulty=easy` or no parameter. The agent filter is unchanged.
- **D3.** The internal option is unchanged. `startGame` and `claimGameSession` still accept a difficulty from tests and evals, which use it to exercise the classifier profiles. `monitor_difficulty` stays in the database and in `PublicGame`.

## Criterion to check mapping

| Criterion    | Check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Evidence                                                                                                                                                                                                                                                                              |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1           | SSR tests assert no difficulty words in the landing, Rules, leaderboard and history row markup; `npm run typecheck`. The absent `difficulty` request parameter is a diff-read item for the lead                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Pass. `tests/copy-cleanup.test.ts` and `tests/pinned-player-ui.test.ts`; typecheck clean. Lead read the diff: the leaderboard request is `/api/leaderboard?agent=`                                                                                                                    |
| C2           | SSR tests assert each new string and the absence of each old string                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Pass. `tests/copy-cleanup.test.ts`, `tests/landing.test.ts`. Recorded red before the copy change                                                                                                                                                                                      |
| C3           | SSR test asserts leaderboard headers and the history row; typecheck on `Score`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Pass. `tests/copy-cleanup.test.ts`; typecheck clean                                                                                                                                                                                                                                   |
| C4           | Lead reads the diff; `npm run format:check`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Pass. Lead read the README and admin label diff; `npm run format:check` clean                                                                                                                                                                                                         |
| A1, A2, A3   | New `tests/integration/agent-model.test.ts` with real Postgres and Better Auth sessions for no session, anonymous, member and SQL-granted admin. A strict catalog fake serves one accepted allowlisted model and one allowlisted model that `getModel` rejects, and fails on any other request                                                                                                                                                                                                                                                                                                                                                                                                                                   | Pass. `tests/integration/agent-model.test.ts`                                                                                                                                                                                                                                         |
| A4           | Route-handler cases in `tests/integration/sprites.test.ts` using the real `POST /api/games` and prompt handlers; `tests/agent-model.test.ts` unit-tests `publicAgentSettings`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Pass. `tests/integration/sprites.test.ts` case "an admin-set attacker model pins new runs and later instructions"; `tests/agent-model.test.ts`                                                                                                                                        |
| A5           | Integration test applies `017` twice                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Pass. `tests/integration/agent-model.test.ts` applies `017` twice                                                                                                                                                                                                                     |
| A6           | `env -i PATH="$PATH" NODE_ENV=production node --import tsx -e "await import('./lib/monitor-worker.ts')"` exits 0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Pass. Probe exits 0 at baseline and after the change                                                                                                                                                                                                                                  |
| A2, A3 UI    | `tests/admin-agent-model.test.ts` SSR-tests an exported card component for the selected model, the changed-by line and the refusal text. `npm run build` proves the action and page wiring compile. Browser inspection of `/admin` is not run locally: `lib/db.ts` forces TLS, so the dev server cannot use the disposable Postgres, and the shared development database must not be migrated from a worktree. It is a gate before merge on the Vercel preview, which migrates its own database branch. Three cases need recorded evidence: an admin saves a model and sees it selected with the changed-by line; a refused value shows the fixed refusal text; a non-admin who posts gets 404 and the settings row is unchanged | Partly run. `tests/admin-agent-model.test.ts` passes and `npm run build` succeeds. The Vercel preview inspection is not run and remains a gate before merge                                                                                                                           |
| M1, M1a, M1b | New cases in `tests/integration/async-backend.test.ts`. M1 is recorded red before the fix. M1a and M1b pin existing behavior and must pass before and after                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Pass. Eight ordering cases in `tests/integration/async-backend.test.ts`, 38 of 38. Against the original ordering the two yield cases fail with the older session or run claimed again. Against never-reviewed-first ordering the two queue-jump cases fail with the newer job claimed |
| M2           | `tests/monitor-progress.test.ts` unit-tests the exported function for every status and for totals of 1 and 3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Pass. `tests/monitor-progress.test.ts`                                                                                                                                                                                                                                                |
| D1, D2, D3   | Route-handler cases in `tests/integration/sprites.test.ts`, `tests/integration/admin.test.ts` and `tests/integration/history.ts`, recorded red before the route change. D3: the existing cases that set a difficulty through `startGame` still pass                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Pass. Eight changed cases fail against the previous routes and pass now. The `monitorReasoning: null` refusal is still asserted with no lease and nothing run. The leaderboard case asserts the captured easy run is absent for every query. No `lib/` diff                           |
| All          | `npm run check`; `npm run test:integration`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Pass. On the final tree, rerun after the difficulty parameter removal: `npm run check` 271 tests, lint, format and typecheck clean. `npm run test:integration` 284 of 284. `npm run build` succeeds                                                                                   |

Prerequisite for integration checks: Docker running with `postgres:17-alpine` cached. Both hold on this machine. `getModel` caches the catalog per process for five minutes, so one fixture must carry both the accepted and the rejected model.

## Implementation steps

Two developers with disjoint file ownership. Each writes its regression first and records the failure. Neither edits `lib/games.ts`, `lib/types.ts` or `lib/sessions.ts`.

**Developer UI** owns `app/page.tsx`, `app/game-ui.tsx`, `README.md`, `tests/landing.test.ts`, `tests/pinned-player-ui.test.ts`, and the new files `tests/copy-cleanup.test.ts` and `tests/monitor-progress.test.ts`.

1. Tests for C1, C2, C3, M2. The Rules panel, leaderboard and history row are inline JSX inside `GameUI`, which cannot render outside Next. Extract each into an exported component with props, following the existing `RunInstructions` and `RunSetupFields` exports, and change nothing else about them. Verify: tests fail on the old copy.
2. Apply C1, C2, C3 and the M2 function in `app/game-ui.tsx` and `app/page.tsx`. Verify: tests pass.
3. README bullets for C4. Verify: `npm run format:check`.

**Developer backend** owns `db/migrations/017-settings.sql`, `scripts/setup.ts`, the new `lib/agent-model.ts`, `lib/policy.ts`, `lib/monitor-jobs.ts`, `app/admin/page.tsx`, the new `app/admin/actions.ts`, the new `app/admin/agent-model-card.tsx`, the new `tests/admin-agent-model.test.ts`, the four routes under `app/api/games/` that call `publicAgentSettings`, `tests/integration/`, and the new `tests/agent-model.test.ts`.

1. M1, M1a and M1b cases in `tests/integration/async-backend.test.ts`. Verify: M1 fails because the older session is claimed again; M1a and M1b pass.
2. In `claimMonitorJob`, order both the candidate query and the in-run query by `coalesce(last_reviewed_at, created_at), created_at, id`. Leave the readiness filters alone. Verify: all three pass and the existing async-backend cases pass.
3. Tests for A1 to A5. Verify: fail for the missing table and functions.
4. Migration `017`: `ctf.settings(key text PRIMARY KEY, value text NOT NULL, updated_by text, updated_at timestamptz NOT NULL DEFAULT now())`. Add it to `scripts/setup.ts` and to the integration harness migration lists that need it.
5. `lib/agent-model.ts`: `currentAgentModel()`; `changeAgentModel(headers, model: unknown)` that authenticates with `auth.api.getSession`, checks `isAdmin`, validates the value is a string in `MODELS`, calls `getModel`, and upserts. Only the four routes and `app/admin/actions.ts` import this file. `lib/policy.ts`: `publicAgentSettings(data, agentModel)` with the model as a required parameter, so typecheck finds every caller. The four routes pass `await currentAgentModel()`.
6. `app/admin/actions.ts` with one exported `"use server"` action. It calls `changeAgentModel(await headers(), formData.get("model"))`, redirects to `/admin?model=refused` on any error, and otherwise revalidates and redirects to `/admin`. Revalidation runs before `redirect`, and `redirect` is called outside the `try`. The page awaits `searchParams`, which is a Promise in this Next version. Read `node_modules/next/dist/docs/01-app/02-guides/server-actions.md`, `forms.md` and `data-security.md` first. Put the card in `app/admin/agent-model-card.tsx` as a server-renderable component that takes the action, the models, the current model, the changed-by line and a refused flag as props, and render it from `app/admin/page.tsx`. The card imports nothing from `actions.ts`, `lib/auth`, `lib/db` or `lib/agent-model`, so its test stays dependency-free. Apply the two C4 admin labels.
7. Verify: the A6 probe, `npm run check`, then `npm run test:integration`.

The lead runs every gate itself, including `npm run build`, checkpoints, then requests simplification and independent review of the full diff.

### Difficulty parameter steps

**Developer backend** also owns `app/api/leaderboard/route.ts` for this step.

1. Change the route-level cases in `tests/integration/sprites.test.ts` that assert the API honors or validates `monitorDifficulty`, and the leaderboard cases in `tests/integration/admin.test.ts`, `tests/integration/history.ts` and `tests/integration/sprites.test.ts` that pass `difficulty=`, so they assert D1 and D2. These tests assert the behavior being removed, so changing them is correct. Cases that set a difficulty through `startGame` or `claimGameSession` directly stay as they are. Verify: the changed cases fail against the current routes.
2. `app/api/games/route.ts` and `app/api/games/[id]/prompt/route.ts` stop passing `monitorDifficulty`. `app/api/leaderboard/route.ts` stops reading `difficulty`, filters on `'hard'`, and loses its "per difficulty" comment and the unused import. Nothing under `lib/` changes.
3. Verify: `npm run check`, the full `npm run test:integration`, `npm run build`.

## Deployment notes

- `migrate prod` applies `017` before Vercel's production alias moves, so new code never runs without the table.
- The claim-ordering change is worker code. It takes effect when the `deploy worker` job ships the new Fly image.
- The partial index `monitor_jobs_ready(next_attempt_at,created_at)` no longer matches the sort. The ready set is small, so no index change is made.
- A repair epoch creates a new job that ranks by its creation time, behind jobs that were waiting before it. The session's older epoch keeps its own rank and must still catch up before a run finalizes.

Plan verification: an independent Opus verifier returned CHANGES REQUIRED on the first draft, for a model-setting placement that would have crashed the monitor worker and for two unowned or unprovable checks. It approved this revision.

## Review and corrective cycle

Two independent Opus reviewers read the full delta, one for correctness against this contract and one for security and deploy safety. Neither found a P0 or P1. Both judged the feature safe to merge after the preview gate. The one automatic corrective cycle covers:

- P2, security: the first version of M1 ranked never-reviewed jobs ahead of every reviewed job, in this run and in others. M1 now ranks by last attention. Regressions: a job created after another job's last review does not go ahead of it; two reviewed runs are ordered by review time.
- P2, correctness: M2 could print "0 of 1 session not fully reviewed." M2 now prints no line when nothing is pending.
- P3: the changed-by line on the admin card is shown only when the stored model is the effective one. Blank lines left in `LeaderboardPanel` by the removed props are deleted.
- P2, both reviewers, not fixable locally: the server action `setAgentModel` has no end-to-end proof. Its redirect, revalidation and logging paths run only inside Next. The Vercel preview gate covers saving, refusal and the non-admin 404. The `console.error` path for unexpected errors stays unproven.

Re-review of the full feature at `4fd3897`: both reviewers found the P2 findings resolved and nothing new at P0 to P2. The preview gate is the only open item. One optional hardening item was raised and not taken: a job that reached the attempts limit through expired claims returns to the front when an append requeues it. Exploiting it needs a transcript that crashes the worker, and no such path was found.

The difficulty parameter removal was reviewed separately at `9f89cb2`: D1 to D3 met, no assertion weakened beyond what they require, nothing at P0 to P2.

Reported and left alone: `/admin` and the four player routes fail with 500 or 503 if `017` has not been applied, so a local database needs `npm run setup` after this merges; "Catches per turn" includes legacy per-command blocks in historical data.

## Checkpoints

- `b4e404e` claim ordering and its regressions.
- `0f27835` admin-set attacker model.
- `5ceb080` copy cleanup and the review status line.
- `8f8ab69` follow-up: ordering case for two reviewed jobs, a redundant key, one README sentence.
- `4fd3897` corrective pass: rank by last attention, no status line when nothing is pending, changed-by line only for the effective model.
- `9f89cb2` difficulty parameter removed at the HTTP boundary.

## Decisions from the user

- A model change applies at each session's next instruction, including runs in progress.
- Worker concurrency is not part of this branch.
- The `monitorDifficulty` API parameter is removed. See D1 to D3.

## Open questions for the user

- Q2. Should a review wait until a session's turn goes quiet? It would cut repeat reviews and their cost, and it would delay catches made mid-turn.

## Known limitations

- Wins recorded as easy or medium under the current monitor version, if any exist, no longer appear on the leaderboard. Not checked against production data.
- The two slow catch-up causes come from reading the code. Review durations in production were not measured.
