# Environment-configured admin seed

Worktree: `/Users/jonathan/Code/ctf/.worktrees/admin-email-env`
Branch: `feature/admin-email-env`
Baseline: `1a9801f6c2537501dc7b7eb522c27754e2ac4dcf`.
Initial tracked tree/index clean; temporary dependency symlink only. Lead implements under the previously approved direct-implementation/independent-review fallback.

## Contract

- A1: Setup reads comma-separated `process.env.ADMIN_EMAILS`, trims and lowercases entries, and ignores empty entries. Unset/blank means no seeded grants; no hardcoded fallback.
- A2: Existing parameterized SQL grants only existing non-anonymous accounts. Reruns are idempotent and omissions never revoke persisted privileges. The completed personal-quota exemption remains governed by the database flag.
- A3: `.env.example` and README document configuration, sign-in then setup, and removal from all setup environments before SQL revocation. Existing `npm run setup` already loads `.env.local` via Node's `--env-file`. Preserve the previous address in this checkout's ignored `.env.local` only if no ADMIN_EMAILS assignment exists. Leave other local settings intact.

## Steps and proof

1. Independent read-only plan review.
2. Add a real setup subprocess regression to the existing disposable Postgres admin integration suite. Use the existing real-pool injection, synthetic environment, and no shared env-file loading. Prove unset/blank, multiple mixed-case/whitespace entries, guest exclusion, missing-account exclusion, reruns and grant preservation. Run before implementation to see the configured grant fail.
3. Change only setup parsing/comment, environment example, README and the ignored local assignment. No schema, authorization or quota behavior changes.
4. Run `npm run check`, `npm run test:coverage`, and `npm run test:integration -- tests/integration/admin.test.ts`; inspect raw results and full delta. Independent final review, then commit owned tracked files. No merge/push/deployment or shared database mutations.

## Evidence

- Independent plan review approved. Relevant Next environment guide and `docs/verification.md` read.
- A1–A2: The new regression failed before implementation because unset configuration granted the former hardcoded account. After implementation, all 4 admin integration tests passed, including five actual setup subprocess runs against disposable Postgres proving unset/blank handling, normalized multiple grants, guest exclusion, missing-account exclusion, idempotency and preservation after omission.
- A3: Environment template and README updated. Added the previous address only to this checkout's existing ignored `.env.local`, after confirming no ADMIN_EMAILS assignment existed; `git check-ignore .env.local` confirms exclusion. No other local configuration changed. Runtime setup contains no fallback address; the old address remains only as a negative regression fixture in tests.
- `npm run check` passed lint, formatting, typechecking and all 232 offline tests. `npm run test:coverage` passed 232 tests (33.23% all-source lines/statements, 85.50% branches, 53.50% functions). `git diff --check` passed.
- Raw logs: `/private/var/folders/vv/0ncq7_rn70x5z37wt_j0lf1r0000gn/T/opencode/admin-email-env-{red,check,coverage,integration}.log`.
- The runtime change is inline parsing plus a revocation comment; no useful further simplification identified. No live setup, shared database mutation, merge, push or deployment performed.
- Independent full-delta final review approved with no findings or blockers; A1–A3 complete.

## Production follow-up

User authorized wiring the production workflow and setting the GitHub Actions repository secret via `gh`. Continue in the same worktree/branch from `bd4315b`.

- A4: The production setup step in `.github/workflows/migrate-prod.yml` receives `ADMIN_EMAILS` from `secrets.ADMIN_EMAILS`. README lists the new required seed configuration. Verify the scoped diff and `npm run check`.
- A5: Set repository secret `ADMIN_EMAILS` on the verified origin `j-pollack/ctf-demo` to the existing local seed address using `gh secret set`; verify its presence through `gh secret list` without reading back secrets. This does not run setup or deploy.
- Independent plan review approved. Added the step-scoped secret mapping and updated README. `npm run check` passed all offline gates and 232 tests; log: `/private/var/folders/vv/0ncq7_rn70x5z37wt_j0lf1r0000gn/T/opencode/admin-email-env-production-check.log`.
- `gh secret set ADMIN_EMAILS --repo j-pollack/ctf-demo` succeeded with the existing seed address. `gh secret list` confirmed the name and update timestamp `2026-11-13T07:54:11Z`; secret contents are not readable through that listing.
- User authorized pushing this branch and creating a PR based on `feature/persistent-run-sessions`. This includes the intervening unmerged commits, not just admin-email configuration. Merge remains pending green PR checks and further authorization.
- Independent final review approved A4–A5 with no findings. Commit only the workflow, documentation and this plan before opening the PR.

## CI repair integration

User authorized merging the repaired base into this branch and pushing to refresh PR #25, while leaving both GitHub PRs unmerged. Source repair `8cdfd34` on `feature/persistent-run-sessions` fixes missing corpus-image preparation, asynchronous Postgres pool teardown, and deprecated Fly region configuration; its independent review and local proof are in `persistent-ci-repair.md`. PR #23 passed GitHub CI (`43481074766`), Vercel and the preview worker (`43481174227`).

Merged source into `/Users/jonathan/Code/ctf/.worktrees/admin-email-env`, branch `feature/admin-email-env`, from baseline `615c7fb` without conflicts. The downstream async-backend teardown correction was already present and merges unchanged. Offline check passes 232 tests; full integration passes all 223 tests. Independent merge-scope review approved with no blockers. Logs use `/private/var/folders/vv/0ncq7_rn70x5z37wt_j0lf1r0000gn/T/opencode/admin-email-env-refresh-{check,integration}.log`.
