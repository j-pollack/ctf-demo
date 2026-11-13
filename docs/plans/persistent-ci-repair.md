# Persistent-session CI repair

Worktree: `/Users/jonathan/Code/ctf/.worktrees/persistent-run-sessions`
Branch: `feature/persistent-run-sessions`
Baseline: `a9ee8aaa4e2b436d088d11158c954141e1d88a82`.
User requested fixes on the originating branch after PR #25 failed. Existing untracked `docs/plans/prov-testing-plan.md` belongs to separate work and is preserved; the running development server is also preserved. Lead implements with previously approved independent-review fallback.

## Evidence and scope

GitHub run `43389547852`: 220/223 integration tests passed. The corpus twin test lacks image `ctf-flag-read-sprite:1`; attribution and read-semantics tests fail with Postgres administrator-termination errors. Run `43389597819`: preview worker provisioning rejects deprecated region `sea` and suggests `sjc`.

CI currently prepares only Postgres. The scenario executor assumes a prebuilt local image and Docker attempts a registry pull if missing. Reliability teardown calls `persisted.end()` then force-drops the database. Installed pg-pool removes clients from its internal list and resolves `end()` before the socket-close callbacks emit `remove`, allowing the forced drop to terminate a still-closing client. A four-policy local baseline passes, consistent with the CI race.

## Acceptance and steps

- A1: CI explicitly builds the corpus stand-in image before integration tests. Local scenario execution uses `--pull=never` so missing prerequisites never trigger an implicit registry fetch. Document the required preparation. Verify actual twin execution using the cached image and inspect workflow ordering.
- A2: Reliability teardown waits for persisted-pool removal callbacks, and drops without FORCE. Apply the already-proven equivalent async-backend teardown correction from the downstream classifier branch to its originating branch. Preserve all real Postgres/Pi/provider-boundary assertions. Existing regressions plus the full integration suite must pass; no arbitrary sleeps or swallowed errors.
- A3: Preview provisioning and production Fly region configuration use `sjc` instead of retired `sea`; validate workflow/config syntax and inspect diff. No live Fly deployment or shared database operation.
- A4: Run `npm run check`, `npm run test:coverage`, targeted integration, full integration and CI-equivalent build with synthetic credentials/no `.env.local`. Independent plan/final review, commit only owned paths. User subsequently authorized pushing this source branch, including its 28 previously unpushed commits already present in PR #25. No merge or direct deployment.

Owned paths: `.github/workflows/{ci,preview-worker}.yml`, `fly.toml`, `scripts/flag-read-scenarios.ts`, `tests/integration/{flag-read-reliability-helper,async-backend.test}.ts`, `README.md`, this plan. If full-suite evidence requires another fix, establish its cause first.

## Verification

Log prefix: `/private/var/folders/vv/0ncq7_rn70x5z37wt_j0lf1r0000gn/T/opencode/persistent-ci-`.

- Independent plan review approved. Baseline four-policy local run passed (`before.log`); CI supplies the observed failure evidence for this timing-dependent teardown defect.
- A1–A2: Targeted four reliability policies, async backend and actual corpus twins: 20/20 pass (`targeted.log`). Full integration suite: 210/210 pass (`full.log`). All tests retain real Postgres/Pi orchestration and existing strict external-service stubs. No live providers or shared database credentials used.
- A3: Both workflow YAML files parse successfully; inspected preview region argument and production primary region as `sjc`. Live provisioning remains unrun.
- A4: `npm run check` passes lint, formatting, typechecking and 223 offline tests (`check.log`). `npm run test:coverage` passes 223 tests; all-source coverage 32.71% lines/statements, 85.31% branches, 53.14% functions (`coverage.log`). `git diff --check` passes.
- CI-equivalent production build passed in a disposable Docker build context. Repository `.dockerignore` excludes local env files; the build confirmed their absence, used synthetic credentials and ran `npm run build` with networking disabled. All routes compiled; expected Better Auth database-validation warnings reflect the intentionally unavailable synthetic DB. The existing development server and local environment files were preserved (`build.log`).
- Changes remain narrow: image preparation, explicit no-pull execution, existing close-barrier pattern, region replacement and operator documentation. No useful further simplification identified.
- Independent full-delta final review approved A1–A4 with no findings. Approval covers this repair delta, not the earlier feature commits. Live Fly provisioning remains unverified until the remote workflow runs.
