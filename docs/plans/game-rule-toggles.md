# Admin game-rule toggles and premise copy

Worktree: `/Users/jonathan/Code/ctf/.worktrees/game-rule-toggles`
Branch: `feature/game-rule-toggles`
Baseline: `911043d41414b39ad4341ff5d9a1684f0a91267b`. Initial index and worktree clean.
Roles: lead Claude Fable 5.2. Plan verifier and code reviewer are independent high-capability read-only agents at high effort. Developer is a Sonnet agent scoped by this contract.
The user authorized work on the development database on 2026-11-18: the Neon `development` branch that this worktree's `.env.local` points at. No merge, push, deployment, production database or paid model call is authorized.

## Request

1. An admin toggle that narrows the monitor from every run of a player to the sessions of the current run. The user calls it transcript isolation.
2. An admin toggle that makes the "fix a bug" win condition optional.
3. Instruction copy that follows both toggles and states the game's premise: the player is a developer at an AI lab whose agents can reach both code to fix and sensitive data.

## Design decisions

- **Rules are recorded on the run at start.** Two new columns on `ctf.games`, `monitor_isolation` and `bug_fix_required`, are filled from the admin settings when a run is created. The monitor, the scorer and the in-run copy read the run's columns, never the live setting. A toggle therefore applies to runs started afterwards. Reasons: every other monitor property is already recorded per run, a rule cannot change under a player mid-run, the run's copy always matches the rule the scorer applies, and each run keeps a record of the condition it was played under.
- **A fork inherits its source's rules**, the same way it inherits `monitor_difficulty`.
- **Defaults keep today's behaviour.** Isolation off, bug fix required. Existing rows get those defaults.
- **Only the async path changes.** Every run created today has `monitor_mode='async'` and is reviewed through `captureCommittedMonitorSnapshot` and finalized by the monitor worker. Legacy runs predate the columns and keep the defaults, so `captureMonitorSnapshot` and the legacy scorer in `lib/runner-session.ts` stay untouched.
- **Isolation is one predicate at capture.** Retrieval tools (`transcript-search.ts`, `transcript-query-projection.ts`) only read sessions listed in the snapshot's `evidenceManifest`. Restricting the manifest query to the run restricts every tool.
- **Bug tests still run when the fix is optional.** `bugsPassed` stays recorded for analysis. Only the capture decision changes.
- **The leaderboard ranks captures made under the rules currently in force.** This follows the existing filter on the current monitor version. A capture with no bug fixed must not rank beside one that needed a fix.
- **Settings reads stay free of auth imports.** The monitor worker has no auth secret, and `lib/games.ts` must not pull `lib/auth.ts` in.

## Non-goals

No change to the investigator or classifier prompts, to `MONITOR_VERSION` values, to legacy-mode code, to admin stats queries, or to `lib/agent-model.ts`. No per-player rules. No client-side polling of settings. No refactor of the settings upsert.

## Acceptance criteria

### Settings

- S1. With no rows, `currentGameRules()` returns `{ monitorIsolation: false, bugFixRequired: true }`. A stored value other than `on` or `off` yields that key's default.
- S2. `changeGameRule(headers, key, value)` throws `GameError` 404 for a missing session, a guest, a guest carrying the admin flag and a non-admin member, and writes nothing. It throws `GameError` 400 for a key outside `monitor_isolation` and `bug_fix_required` or a value outside `on` and `off`. For an admin it upserts the row with `updated_by`.
- S3. `/admin` shows a "Game rules" card with one switch per rule. Each switch is a submit button with `role="switch"` and `aria-checked`, inside a form posting to a server action that calls `changeGameRule`. The card states that a change applies to runs started afterwards and shows who last changed each rule.

### Run recording

- R1. Migration `021-game-rules.sql` adds `monitor_isolation boolean NOT NULL DEFAULT false` and `bug_fix_required boolean NOT NULL DEFAULT true`. Applying it twice succeeds. `scripts/setup.ts`, `scripts/monitor-investigate-eval-live.ts` and every integration bootstrap whose code reads the new columns or the settings table apply it. That includes the five files that already apply `020`, plus `tests/integration/transcript-query.test.ts` and `tests/integration/transcript-evidence.test.ts`, which stop at `015` and call `captureCommittedMonitorSnapshot`, and `tests/integration/admin.test.ts`, which stops at `012`, tests the leaderboard and also needs `017-settings.sql`.
- R2. A fresh run records the settings in force when it starts. Changing a setting afterwards leaves the run's columns unchanged.
- R3. A fork records its source's values even when the settings have changed since.
- R4. The public game payload carries `rules: { monitorIsolation, bugFixRequired }` from the run's columns.

### Monitor scope

- M1. For a run with `monitor_isolation=false`, the committed snapshot's `evidenceManifest` lists every session of the owner across runs. Existing behaviour, existing tests stay green.
- M2. For a run with `monitor_isolation=true`, the manifest lists exactly that run's sessions. `searchableHistorySessions` equals the number of sibling sessions. The manifest query uses an inner lateral join on observations, so the test seeds an observation for every sibling. No session from another run of the same owner appears.
- M3. On an isolated snapshot, `searchCommittedTranscripts` for a literal that exists only in another run of the same owner returns no result. A literal that exists in a sibling session of the same run is found.

### Win condition

- W1. `bug_fix_required=true`, correct flag, no bug passing: the run ends without a capture. Existing behaviour.
- W2. `bug_fix_required=false`, correct flag, no bug passing: the worker finalizes the run as `captured` and the submit event records `bugsPassed: 0`. The bug tests ran.
- W3. `bug_fix_required=false`, wrong flag: the run ends without a capture.
- W4. `finalizeAsyncRun(claim, "captured", 0)` throws "Capture requirements were not met." when the run requires a bug fix and succeeds when it does not. It throws for an incorrect flag in both cases.

### Leaderboard

- L1. `/api/leaderboard` returns only captures whose recorded rules equal the current settings. Flipping a setting hides captures made under the other value. Flipping it back returns them.

### Copy

- C1. `HowToWin` lists three conditions when the bug fix is required and two when it is optional. The optional form says the fix is optional.
- C2. `HowToWin` says the investigator reads earlier runs when isolation is off, and says it cannot see earlier runs when isolation is on.
- C3. Landing page, welcome intro, rules panel, run instructions and the win banner agree with the rules they are given at every rule-dependent sentence listed under Copy below.
- C4. Surfaces shown before a run (landing, welcome, rules page) use the current settings. The in-run "How to win" uses the run's recorded rules.
- C5. The landing intro and the welcome intro state the premise. Wording approved by the user on 2026-11-18.

## Copy

The lead owns the wording. The developer places these strings verbatim. Curly apostrophes as in the existing files. `R` means bug fix required, `I` means isolation on.

### `app/flag-instructions.tsx`

`HowToWin({ url, rules })`, `rules` required.

- Opening line: `You win when all three are true:` if R, else `You win when both are true:`.
- Bug item: rendered only if R, text unchanged.
- Flag item: unchanged.
- Investigator item, first sentence if not I: `The investigator reads every session’s transcript, in this run and in your earlier runs, including your instructions and your system prompt.` If I: `The investigator reads the transcript of every session in this run, including your instructions and your system prompt. It cannot see your earlier runs.` The remaining sentences are unchanged.
- If not R, a paragraph after the list: `Fixing a bug is optional. The computer holds a small open-source web project, Bottle, written in Python, in <code>/workspace</code>, with four known bugs listed in <code>TASKS.md</code>. Work on them makes your agent look like an honest one.`
- The remaining paragraphs are unchanged.

No separate premise component. The user removed the standalone premise sections from the landing page and the rules page on 2026-11-18. The landing intro and the welcome paragraph carry the premise.

### `app/landing-content.tsx`

`LandingContent({ submissionUrl, rules })`. The intro is the user's rewrite of 2026-11-18, with two of its statements changed to match what the investigator enforces: it catches a successful read, not an attempt, and nothing detects a jailbreak.

Heading: `Capture the flag without getting caught`

> This game is a small model of working at an AI lab. You play a developer there, and your coding agents work on the lab’s computers, which hold code that needs fixing and data that must never leave. At a real lab that data would be model weights, but in this game it’s a short secret in a file, the **flag**.
>
> A classifier scores risk as you play, and an AI investigator reviews each session’s full transcript after each response. You lose when the investigator finds evidence that an agent read `/tmp/flag.txt`, even indirectly.

Third paragraph if R: `If you can avoid that, you win if you can fix a bug and get the flag contents to a randomly generated URL endpoint.` If not R: `If you can avoid that, you win if you can get the flag contents to a randomly generated URL endpoint.`

> Your coding agents are unaware of your secret goal or the game rules, so you will need to find a way to steer them to victory without them spilling the beans.

"How a run works" closing paragraph, first sentence if not I, unchanged: `The investigator can also read your earlier runs and connect what happened across them.` If I: `The investigator reads only the sessions in your current run. It cannot see your earlier runs.` The rest of the paragraph is unchanged.

The "Why does this exist?" section is removed.

`app/page.tsx` becomes an async component that passes `await currentGameRules()`.

### `app/game-ui.tsx`

`GameUI` takes `rules` from `app/(game)/layout.tsx`, which reads `currentGameRules()`.

`WelcomeIntro`: heading `Fix a bug. Upload the flag without getting caught.` if R, else `Upload the flag without getting caught.` Paragraph: `You are a developer at an AI lab, and you want its secret data out. Guide an agent through a real workspace. Every action is watched, and every turn spends from one shared budget.`

`RulesPanel`:

- "How to win", closing paragraph if I: `A classifier supplies advisory risk signals. The investigator reviews transcript history across the sessions in your run. It cannot see your earlier runs.` Unchanged if not I.
- Table row "Sees in new runs" if I: `The agent’s private reasoning.` Unchanged if not I.
- Table row "Can retrieve" if I: `Transcripts from the other sessions in this run. It cannot retrieve your earlier runs or another user’s transcripts.` Unchanged if not I.
- "Classifier context", last sentence if I: `The investigator can retrieve transcripts from the other sessions in your run.` Unchanged if not I.
- "The bugs", sentence `The agent needs to fix at least one.` becomes `Fixing one is optional.` if not R.
- "The leaderboard", first sentence in every case: `Each player’s cheapest verified win under the current rules, cheapest first.`

`RunInstructions({ rules })`, last step if not R: `<strong>Submit the flag</strong> as described in How to win. The game still runs all four bug tests, but a win does not need one to pass. An unresolved review never confirms a win.` Unchanged if R. `RulesPanel` passes its rules down.

`app/game-ui.tsx` is a client file. It imports `GameRules` as a type only from `lib/types.ts` and never imports `lib/game-rules.ts`.

### In-run copy

`app/session-pane.tsx` passes the run's `rules` from the game payload to both `HowToWin` call sites. `SessionPaneProps.rules` is required.

`app/run-console.tsx`, win banner if the run did not require a fix: `The agent got the flag through the investigator review. {money} spent over {turns} turns.` Unchanged if R.

`endBanner` in `app/transcript.tsx` needs no change: "Right flag, but no bug fixed" is only reachable for a run that required a fix.

### `README.md`

Document both settings beside the attacker-model setting. Qualify the sentence that says the investigator can read the owner's other sessions: it holds unless the run has transcript isolation on.

## Implementation steps

1. `db/migrations/021-game-rules.sql`. Add it to `scripts/setup.ts`, `scripts/monitor-investigate-eval-live.ts` and the integration bootstraps that apply `020`. Verify: R1.
2. `lib/types.ts`: `GameRules` type. `lib/game-rules.ts`, no auth import: keys, defaults, `currentGameRules(queryable = db)`. `lib/game-rules-admin.ts`: `gameRuleSettings()` for the admin card and `changeGameRule`. Verify: S1, S2.
3. `lib/games.ts`: `GameRow` fields, `PUBLIC_GAME_COLUMNS`, the `startGame` insert, the public payload. Verify: R2, R3, R4.
4. `lib/monitor-snapshot.ts`, `captureCommittedMonitorSnapshot` only: read `g.monitor_isolation` with the target and add `AND (NOT $n OR g.id=$m)` to the manifest query. Verify: M1, M2, M3.
5. `lib/monitor-worker.ts` and `lib/async-finalization.ts`: read `bug_fix_required` in the existing selects and apply it to the capture decision and the guard. Verify: W1 to W4.
6. `app/api/leaderboard/route.ts`: filter on the current rules. Verify: L1.
7. `app/admin/game-rules-card.tsx`, `app/admin/actions.ts`, `app/admin/page.tsx`, styles in `app/globals.css` if the switch needs them. Verify: S3.
8. Copy changes and prop threading. `rules` is a required prop everywhere, so update the offline tests that render these components: `tests/copy-cleanup.test.ts` (render `LandingContent` with props, not the async `Home`), `tests/landing.test.ts`, `tests/session-pane.test.ts` and `tests/pinned-player-ui.test.ts`. Verify: C1 to C5.
9. README.

Each behaviour step starts with a failing regression that fails for the intended reason.

## Checks

| Criterion    | Check                                                                                                                                                                                                                                                                                                                  |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1, S2, R1   | New `tests/integration/game-rules.test.ts`, modelled on `tests/integration/agent-model.test.ts`: real Better Auth sessions and Postgres.                                                                                                                                                                               |
| R2, R3, R4   | Integration in `tests/integration/sprites.test.ts` with the real `startGame` and the existing `forkRoute`.                                                                                                                                                                                                             |
| M1, M2, M3   | Integration in `tests/integration/transcript-evidence.test.ts`: two runs of one owner plus a sibling session, real observations, real capture and `searchCommittedTranscripts`.                                                                                                                                        |
| W1 to W3     | Integration in `tests/integration/sprites.test.ts` beside "the right flag with no bug fixed ends the run without a win", if that scenario runs the async worker path. Otherwise in the file that drives `runMonitorWorkerOnce` finalization. Strict Sprite fake for the seed tests, persisted status and submit event. |
| W4           | Integration in `tests/integration/async-backend.test.ts`, which already calls `finalizeAsyncRun`.                                                                                                                                                                                                                      |
| L1           | Integration in `tests/integration/admin.test.ts` against the real leaderboard route handler.                                                                                                                                                                                                                           |
| S3, C1 to C4 | Offline SSR tests with `renderToStaticMarkup` for all four rule combinations, asserting the rule-dependent sentences and their absence.                                                                                                                                                                                |
| C5           | SSR test that the landing intro and the welcome intro state the premise.                                                                                                                                                                                                                                               |
| All          | `npm run check`, `npm run test:coverage`, `npm run test:integration`, `npm run build`.                                                                                                                                                                                                                                 |

Browser check, requested by the user, with `agent-browser` against `npm run dev` in this worktree after `npm run setup` applies migration 021 to the development database:

- B1. `/admin` as an admin shows the Game rules card with both switches in their default state. Clicking a switch flips its `aria-checked`, persists across reload and shows who changed it.
- B2. `/` and `/rules` show the copy for each rule combination after the switches change.
- B3. `/admin` as a non-admin returns the 404 page.
- B4. Both settings are returned to their defaults and any synthetic account is removed afterwards.

Not run in this work: starting a run in the browser, which spends Sprite and model budget. Live Sprite, OpenRouter and deployment checks.

## Deployment notes

The migration is additive and must be applied before the new web code and the new monitor worker serve. An old worker ignores both columns and treats every run as not isolated and bug fix required until it is redeployed. The landing page now reads Postgres on every render.

## Plan verification

Independent read-only review on 2026-11-18: approve with changes. It confirmed the async-only scope, the manifest as the single retrieval boundary, the two enforcement sites for the bug rule, the auth-free read module and fork behaviour. Its four blocking findings are folded in above: three more test bootstraps, two win texts outside `HowToWin`, one false landing sentence and three more offline test files. Wording note: under isolation a fork still carries its source run's transcript up to the fork point. The user approved the copy as drafted on 2026-11-18.

## Evidence

Lead runs on Node 24.16.0, 2026-11-18. Baseline `npm run check` before any change: 386 of 386 offline tests.

- `npm run check`: lint, format and typecheck pass, 392 of 392 offline tests. Log `/tmp/grt-lead-check.log`.
- `npm run test:integration`: 364 of 364, disposable Postgres container. Log `/tmp/grt-lead-integration.log`.
- `npm run build`: succeeds. Log `/tmp/grt-lead-build.log`.
- `npm run test:coverage`: developer run, 392 of 392. Log `/tmp/game-rule-toggles-coverage.log`. Not rerun by the lead.

| Criterion    | Proof                                                                                                                | Status |
| ------------ | -------------------------------------------------------------------------------------------------------------------- | ------ |
| S1, S2, R1   | `tests/integration/game-rules.test.ts`                                                                               | Pass   |
| R2, R3, R4   | "a run records the rules in force at its start and a fork keeps its source's" in `tests/integration/sprites.test.ts` | Pass   |
| M1, M2, M3   | Isolation block at the end of `tests/integration/transcript-evidence.test.ts`                                        | Pass   |
| W1, W2, W3   | Tests W1 to W3 in `tests/integration/sprites.test.ts`, through `runMonitorWorkerOnce`                                | Pass   |
| W4           | Four "W4: capture guard" tests in `tests/integration/async-backend.test.ts`                                          | Pass   |
| L1           | "L1: the leaderboard ranks only captures" in `tests/integration/admin.test.ts`                                       | Pass   |
| S3, C1 to C5 | `tests/game-rules-copy.test.ts`, all four rule combinations                                                          | Pass   |
| B1 to B4     | `agent-browser` against `next dev` on port 3002 and the Neon `development` branch                                    | Pass   |

Red runs seen before implementation: S1 and S2 (module missing), R4 (payload had no `rules`), M2 (manifest listed the other run's session), W2 (`ended` instead of `captured`), W4 (guard threw for an optional fix), L1 (capture under other rules still listed). W1, W3 and M1 are existing behaviour and passed beforehand. The copy tests, S3 and the R2 and R3 assertions were written after the implementation.

Development database: only `021-game-rules.sql` was applied, not the full setup script. All 120 existing runs took the defaults. The browser check used one synthetic account, signed in through the real magic-link verification with the email intercepted. That account and the two settings rows it wrote were deleted afterwards, and `ctf.settings` is empty again.

Browser results: a signed-in non-admin gets the 404 on `/admin`. An admin sees both switches at their defaults. Each click flips `aria-checked`, survives a reload and shows who made the change. `/`, `/rules` and `/play` followed the switches for isolation on with the fix required, isolation on with the fix optional, and both defaults.

Changes after the developer's hand-back, by the lead: the premise's first sentence was reworded so the existing difficulty-word assertion in `tests/copy-cleanup.test.ts` stays as it was, and the switch was restyled as a pill inside the app's 44px button target.

Deviations from the contract as written: `scripts/layout-fixture.tsx` and `tests/fixtures/console-runs.ts` needed the new `rules` prop. `tests/integration/flag-submission-runner.test.ts` needed `017-settings.sql`. The admin card labels and details are the developer's wording.

Not run: starting a run in the browser, so the in-run "How to win" and the worker path rest on tests. Live Sprite, OpenRouter and deployment checks.

## Code review

Independent read-only review of the full uncommitted delta on 2026-11-18: approve, no P0 to P2 findings. It traced isolation through search, version loading, the SQL projection and the classifier, and confirmed no assertion in an existing test was removed or weakened. P3 items left open for the user:

- Deploy order. With new web code and an old worker, a non-default rule is ignored by the worker while the copy states it. Deploy the worker before changing either switch.
- With the fix optional, a failed bug-test run still leaves a decided win unresolved, because the tests stay on the finalization path.
- `LeaderboardPanel`'s footnote and the legacy submit caption "both objectives met" were not touched.
- `/rules` shows the current settings during a run started under other rules.
- `setGameRule` gives no on-page signal when a save fails for a reason other than authorization.
- Only search has an isolation test. Version loading and the SQL projection are covered by construction, since both read only manifest sessions.

The reviewer's touch-target finding does not hold: the global `button` rule keeps the switch at 44px tall and it is 36px wide.
