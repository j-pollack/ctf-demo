# Fast monitor timing verification

## Scope and checkout

- Worktree: `/Users/jonathan/Code/ctf/.worktrees/fast-monitor-timing`; branch: `feature/fast-monitor-timing`.
- Base: `fa96259a0e2b0523c73054ae807be016b1aa2abd`. Initial tracked/index state clean; temporary dependency symlink only.
- User approved shorter injected integration timing budgets, pinned production defaults, and an opt-in full-duration check. Continue lead direct implementation and independent general-agent review using the previously approved fallback; no model/effort overrides available or claimed.
- Keep real native cancellation, Postgres leases, Pi orchestration, classifier admission and settlement. Only permitted external service transports remain faked. No global clock replacement, environment-configurable production deadlines, schema changes, provider/profile changes, live paid calls, merge, push or deployment.

## Criteria

| ID  | Observable criterion and check                                                                                                                                                                                                                                                        | Status   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| T1  | Omitted timing keeps investigator 90s, classifier 15s and claim 120s; pure tests pin defaults and reject invalid or longer injected deadlines. Native investigator deadline remains capped by the existing driver.                                                                    | Verified |
| T2  | Worker and bounded evaluator accept explicit shorter investigation/classifier budgets. Their existing allow/block/accounting/hold assertions pass, including short successful responses, investigator abort and classifier abort. Real claim duration remains 120s; no lease mocking. | Verified |
| T3  | Routine production and baseline timing scenarios use 3s investigator / 1s classifier budgets with 0.5s success and longer stalled fake responses. A missing injection fails behavioral/timing assertions rather than silently retaining 90s waits. No routine 65s/90s/15s sleeps.     | Verified |
| T4  | `npm run test:integration:timing` runs one production worker deadline scenario with omitted timing options and the real 90s default, against disposable Postgres and synthetic providers. Ordinary integration execution never selects it implicitly.                                 | Verified |
| T5  | Check, all-source coverage and all integration files pass; independent full-delta review approves. Record failed attempts and actual timings.                                                                                                                                         | Verified |

## Implementation and proof

1. Independently review this plan. Add pure/default-validation and shortened integration regressions, demonstrate failure before implementation.
2. Add a small typed timing resolver beside `BOUNDED_INVESTIGATOR_POLICY`. Accept only positive integer investigation/classifier durations at or below defaults. Keep claim duration fixed; production entrypoints omit options. Worker receives optional timing, evaluator receives optional `timing` in existing internal options. Validate before database work. Pass the shorter investigation limit through existing `RunMonitorReviewInput.deadlineAt`; retain native `AbortSignal.timeout` for classifier and existing driver/claim bounds.
3. Share fast fixture values in a narrow integration helper; use injected budgets only in the long timing scenarios. Preserve external response validation, persisted outcomes and billing assertions. Default-path scenarios continue omitting timing.
4. Extend the existing disposable runner with a dedicated `--real-timing` selector and package script. It selects only the production deadline scenario through a test-only environment flag. Production source never reads that flag; user credentials remain filtered out.
5. Run `npm run check`, `npm run test:coverage`, the targeted baseline/production tests, and all integration files sequentially through the existing runner. Run the new opt-in synthetic full-duration check once to prove the command. Independently review, record evidence and commit.

Owned: `lib/investigator-evaluation-policy.ts`, `lib/monitor-worker.ts`, `scripts/flag-read-eval-live.ts`, `scripts/test-integration.ts`, `package.json`, a focused pure timing test, `tests/integration/monitor-timing.ts`, `tests/integration/flag-read-production.test.ts`, `tests/integration/flag-read-baseline.test.ts`, `docs/verification.md` (command description), and this plan. No dependency changes. Relevant Next TypeScript guide and repository verification policy read.

Baseline evidence: prior commit passed 240 offline and 249 integration tests. Serial production timing suite took 181.7s; baseline suite took 229.1s. Node fake timers were experimentally confirmed to advance `setTimeout` but not `AbortSignal.timeout`; Postgres uses its own real clock. Prior concurrent failure had widespread scheduling delays under host load, so this task shortens deliberate waits rather than relaxing assertions.

## Verification progress

- Independent plan reviewer approved the narrow timing seam and existing `deadlineAt` reuse. Investigation deadlines are computed after classification; timing validation precedes worker finalization and evaluator database setup.
- Red regression: before runtime edits, shortened production tests failed because the investigator completed with `caught-up` instead of `queued`, and classifier timeout incorrectly reached investigator dispatch. The fake responses returned after 10s/5s, proving the absent injection through observable outcomes rather than import failures.
- `npm run check` and `npm run test:coverage` passed 243 tests. Targeted production/baseline integration passed 35 tests. Production suite: 17.35s (previously 181.7s); baseline suite: 69.54s (previously 229.1s), with concurrent targeted execution. Scenario durations include subprocess setup.
- Independent reviewer `ses_e28fade5bffesIb0MLISzAIo2e` approved the complete delta and final raw evidence with no P0–P2 findings; T1–T5 satisfied for commit. No additional simplification was needed: existing driver/lease mechanisms are reused with one small timing resolver and fixture helper.
- Full serial integration: all 19 files ran exactly once, 249 passed with zero failed/cancelled/skipped. Summed test duration was 234.81s, excluding container startup/cleanup. Production suite took 15.71s; baseline took 67.67s. Opt-in `npm run test:integration:timing` passed its single default-budget deadline scenario plus parent (2 tests), 91.92s total, with queued review and retained billing hold assertions.
- Evidence logs use prefix `fast-timing-` in `/private/var/folders/vv/0ncq7_rn70x5z37wt_j0lf1r0000gn/T/opencode/`: `red.log`, `check.log`, `coverage.log`, `targeted.log`, `full.log`, `real.log`. `git diff --check` passed. No live services, merge, push or deployment performed; the synthetic opt-in check is not live-service deployment proof.
