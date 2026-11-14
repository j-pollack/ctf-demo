# Resolve PR #25 against the promoted monitor base

Worktree: `/Users/jonathan/Code/ctf/.worktrees/admin-email-env`
Branch: `feature/admin-email-env`
Head before merge: `2cb8b2e3cd8e3875f4197d3ed2d9b20d236d1ac6`
Incoming base: `6b3a99da4bc1d13e3e5333e3784a325e0f9b02fa` (`origin/feature/persistent-run-sessions`).
Initial index and tracked tree clean. User requested conflict resolution; existing authorization covers refreshing and pushing this PR branch. Both GitHub PRs stay unmerged. Lead implements with previously approved independent-review fallback.

## Contract

- C1: Preserve incoming production presumption v14, DigitalOcean restrictions, bounded accounting/deadlines, original v7 fork policy and all new timing tests. Retain the admin quota exemption and environment setup changes. Resolve imports in games by combining both sides.
- C2: Preserve context-budgeted history and bounded shrinking retries. Every dispatch, including each retry, uses incoming authorization/reservation/settlement. Command evaluation occurs once. Context helper delegates dispatch to the real authorized evaluator instead of bypassing its accounting. Verified successes settle once; dispatched failures keep their unknown holds, matching incoming policy. No automatic refund based solely on a provider error.
- C3: Keep both conflicting async test groups and exercise context retries in both legacy and reserved-budget modes, asserting persisted charges, retained holds, revocation/abort and retry bounds. Historical context32k v8 runs remain reviewable under their original investigator prompt and recorded run/review version; do not reinterpret them as production presumption. Explicit historical v7 evaluation remains unchanged.
- C4: Offline check, coverage, full disposable integration and independent full resolution review pass before merge commit/push. No shared env/database or paid calls. CI validates the merged production build after push.

## Scope and steps

1. Independently review this contract and the four conflicts before source resolution.
2. Combine `lib/control.ts` version constants, `lib/games.ts` imports, `lib/monitor-classifier.ts` dispatch logic, and both `tests/integration/async-backend.test.ts` blocks. Adapt `lib/classifier-context.ts` to dispatch through the real accounting path. Add narrow v8 policy mapping and regression in `lib/flag-read-policy.ts`, `tests/flag-read-policy.test.ts`, and the existing production-worker integration fixture.
3. Run targeted async/admin/production worker integration; preserve or add failure proof for composed reserved-budget retry behavior. Run offline/coverage and full suite, inspect incoming auto-merges, independently review, commit and push. Record actual results here.

## Evidence

- Independent plan review approved. Incoming plans identify v14 fresh runs, v7 forks, 15s classifier deadline and 90s bounded investigator policy as intentional. No conflicts in UI/admin setup; those changes remain intact.
- Red proof: simply combining context retries with the incoming reserved mode failed all seven reserved scenarios because the context dispatch had no reservation (1 row instead of 2). The v8 policy regression failed as unsupported. Logs: `admin-conflict-red-{integration,policy}.log`.
- Targeted async/admin/real production-worker integration: 45/45 passed after composition, including 13 legacy/reserved retry scenarios, retained unknown holds, budget denial on retry, original claim-duration tests and real v8 worker attribution. Unit regression preserves v7 prompt hash and rejects unknown versions.
- `npm run check` and coverage passed 253 offline tests; all-source coverage 33.92% lines/statements, 85.30% branches, 54.16% functions. `git diff --check` passed.
- Full disposable integration passed all 270 tests (`admin-conflict-full.log`). Independent review against both parents approved the complete resolution with no blockers; no unresolved index entries remain. C1–C4 local proof complete; GitHub will run the refreshed CI/build and preview checks after push.
- Logs are in `/private/var/folders/vv/0ncq7_rn70x5z37wt_j0lf1r0000gn/T/opencode/`, prefix `admin-conflict-`. No further simplification identified without changing the intended behavior. No shared database operations or direct deployment performed.
