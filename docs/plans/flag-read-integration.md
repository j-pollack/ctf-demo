# Integrate verified flag-read evaluation work

- Working checkout: `/Users/jonathan/Code/ctf/.worktrees/flag-read-heldout`
- Working branch: `feature/flag-read-heldout`; verified starting HEAD `83ff4bced354fa45afce0ad1132057b3961f4d38`.
- Authorized target: `/Users/jonathan/Code/ctf/.worktrees/persistent-run-sessions`, branch `feature/persistent-run-sessions`, initial HEAD `c2821b58efb83db38a1a01221a9533c45feca2af`.
- User approved integration after the held-out result. Production policy selection and deployment are separate; this merge incorporates the evaluation-only candidate and verified tooling.
- Source checkout has untracked `heldout-run-001/` paid artifacts; preserve them. Target has untracked `docs/plans/prov-testing-plan.md`; preserve it byte-for-byte. Both tracked worktrees and indexes initially clean. Primary checkout is `/Users/jonathan/Code/ctf` and remains unchanged during verification.

## Contract and sequence

1. Merge the target into the existing feature checkout, resolving only actual conflicts and retaining target worker deployment, submit visibility and Postgres teardown repairs. Preliminary `git merge-tree --write-tree` reports a clean merge.
2. Verify combined source with `npm run check` and the real disposable-Postgres integration suite, using synthetic service credentials only. Preserve historical schedules and their original-source hashes; a combined-source live evaluation would need a new schedule rather than overwriting run provenance. No paid reruns.
3. Independently review the combined merge against both parents and verification evidence, focusing on runtime/accounting/default-policy and target changes.
4. Confirm the target HEAD and unrelated untracked file have not changed, then fast-forward the target to the verified combined commit. No push or deployment.
5. Assess cleanup only after successful integration. The completed feature checkout contains retained paid-run artifacts and cannot be removed while dirty; do not force removal or discard them. Retain the checkout and report this blocker unless archival is separately arranged. Keep branches.

## Acceptance

| ID  | Evidence required                                                                                    | Status                           |
| --- | ---------------------------------------------------------------------------------------------------- | -------------------------------- |
| I1  | Both source and target histories included; target-only changes preserved; no unintended source edits | Passed                           |
| I2  | Offline and combined real-Postgres integration checks pass; independent review has no blockers       | Passed                           |
| I3  | Authorized target fast-forwarded, untracked user file unchanged, no push/deployment                  | Passed                           |
| I4  | Cleanup completed or precise retained-artifact blocker reported                                      | Retained artifacts block removal |

Node 24.16.0; installed dependency symlink during checks, removed afterwards. Raw paid artifacts are temporarily moved outside formatter discovery for checks, then restored byte-for-byte. Their local database containers remain retained. Working-tree isolation does not authorize shared database access.

## Completion evidence

- Automatic merge required no conflict resolution or source edits. Merge commit `c3673ff` includes both verified source history and target history; the target was fast-forwarded to this combined commit after verification.
- `npm run check`: 239/239 passed, zero skipped. Full unfiltered `npm run test:integration`: 238/238 passed, zero skipped. Both commands exited 0. Logs: `/private/var/folders/vv/0ncq7_rn70x5z37wt_j0lf1r0000gn/T/opencode/flag-read-merge-{check,integration}.log`; result record: `flag-read-merge-check-results.json` in the same directory.
- Independent full-delta review against both parents and final gate review approved the local integration with no merge-introduced blockers. Production remains `current`, non-bounded investigations retain 60s, and DigitalOcean/90s remains bounded-evaluation-only. Target submit visibility, migrations, worker deployment and teardown fixes are preserved.
- Target HEAD, branch, tracked/index cleanliness and SHA-256 of the user's untracked `docs/plans/prov-testing-plan.md` were checked before fast-forward. All ten held-out artifacts were restored with byte-identical hashes. Historical schedules remain original-run provenance and will reject combined-source drift; no paid evaluation was repeated.
- The completed feature worktree remains at `/Users/jonathan/Code/ctf/.worktrees/flag-read-heldout` because untracked `heldout-run-001/` contains the retained paid artifacts. Automatic cleanup is blocked; no force removal or artifact deletion was attempted. Branches and retained evaluation databases remain available.
- No push, deployment, shared-database migration or production-policy promotion was performed. Combined-source tests are deterministic integration evidence, not a new live held-out result.
