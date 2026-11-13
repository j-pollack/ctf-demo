# Admin exemption from personal run quota

Worktree: `/Users/jonathan/Code/ctf/.worktrees/admin-run-quota`
Branch: `feature/admin-run-quota`
Baseline: `32bc0218b6e1e7ddb444cae878c62b3ed489e2c5`.
Initial index/worktree clean; temporary untracked dependency symlink only. Lead implements with previously approved independent-review fallback. Primary checkout remains unchanged; no merge/push/deployment or live database mutations.

## Scope

Exempt signed-in, non-anonymous admins from the personal three-new-runs-per-rolling-24-hours quota. Use the current persisted `ctf."user"."isAdmin"` flag with the existing `isAdmin` predicate inside `startGame` admission, never a client-supplied privilege bit. Existing `ADMIN_EMAILS` in `scripts/setup.ts` seeds admin grants; do not create another allowlist.

Preserve shared daily spend, global 100-new-run cap, environment capacity, ownership, busy-session, per-run budget and fork eligibility checks. Admin runs still persist `new_run=true` and count toward global admission. Non-admin, anonymous and missing user records do not gain an exemption. Cover revocation on the next request. No schema/auth/config or UI feature changes.

## Acceptance → checks

- A1: An admin's fourth fresh start succeeds and persists normally; an ordinary member's fourth is rejected without ending the current run. Real Better Auth cookie/route and Postgres/Sprite orchestration integration.
- A2: Client `isAdmin`/owner hints cannot grant exemption; revoking the persisted flag removes it even with the same cookie; anonymous/missing users cannot qualify. Real routes and direct admission where appropriate; no mocked auth.
- A3: Admins still hit global run/spend limits and new-run forks receive the same personal exemption. Targeted integration with actual persisted counters and existing strict external boundary fakes.
- A4: README documents seeded grants, listing current admins, and personal exemption. Offline gates `npm run check`, `npm run test:coverage`, targeted disposable `tests/integration/sprites.test.ts`; independent full-delta review.

## Steps

1. Independent read-only plan verification; baseline offline check.
2. Add a failing admin-quota integration regression, implement narrowly in `lib/games.ts`, document the admin query in README, and run the integration gate.
3. Run offline/coverage gates, review owned delta and simplify only if useful, independently review and commit verified changes.

## Evidence

- Independent plan review approved. Baseline offline gate passed.
- A1–A3: Five added real-cookie/Postgres integration scenarios pass: admin fourth start and next-request revocation; ordinary-member denial despite forged privilege/owner fields; anonymous and missing-user denial; quota-consuming admin fork; global spend and global 100-start rejection. Assertions cover persisted owner, status, `new_run` and counts. The pre-fix run failed on admin fourth starts/forks and the global-cap reason, as expected. One fixture expectation was corrected from 403 to the existing guest-auth 401 response.
- A4: README now includes the authoritative admin query and exemption scope. `npm run check` passed lint, formatting, types and all 232 offline tests on Node 24.16.0. `npm run test:coverage` passed 232 tests; all-source coverage is 33.23% lines/statements, 85.50% branches and 53.50% functions. `npm run test:integration -- tests/integration/sprites.test.ts` passed all 173 tests.
- Raw logs: `/private/var/folders/vv/0ncq7_rn70x5z37wt_j0lf1r0000gn/T/opencode/admin-run-quota-{before,red,check,coverage,integration}.log`.
- The runtime change is limited to the personal-quota rejection in `startGame`; the shared limits and serialized admission remain in the same transaction. Existing admin predicate is reused. No useful further simplification identified.
- Tests follow `docs/verification.md`, use disposable Postgres and synthetic credentials, and never read shared `.env.local`. No live provider/deployment checks or actual admin-list database query were run.
- Independent full-delta code review approved with no findings or blockers; A1–A4 complete.
