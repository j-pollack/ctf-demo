# One-row top navigation

- Worktree/CWD: `/Users/jonathan/Code/ctf/.worktrees/top-navigation`
- Branch: `feature/top-navigation`
- Baseline: `e1443e7` (verified direct sign-out prerequisite, committed at user request). Initially clean.
- Primary `/Users/jonathan/Code/ctf` remains unchanged. Commit authorized; no merge, push or deployment authorized.
- Lead owns plan, isolated QA and commits. GPT-6.1/high independent verifier/reviewer; GPT-6-Luna/medium scoped developer.

## Scope and decisions

Replace the vertical rail plus separate horizontal header with one shared horizontal top row on home and game pages. Order: Rules, Rank, My Runs, Sign in/out, Play. Keep one brand/home link. Play is the primary CTA and always resumes the active run via the existing canonical /play behavior. User clarified: New run belongs on the Play page, never in global navigation. Preserve empty-active-run replacement guards, pending/loading gates, account/session behavior, current-page semantics and run ownership.

Use a small shared header component for home/GameUI; reuse AuthAction and existing navigation behavior. Remove only the rail/top-actions styles and markup made obsolete by this change. Keep a single New run control within Play content; preserve existing setup modal and create action. No duplicate empty-state create control. Keep landing-page hero Play CTA (content, not a second navigation row).

Non-goals: auth/backend/schema changes, run lifecycle changes, route reorganization, unrelated visual redesign, new dependencies, mobile hamburger/sidebar. Responsive header must stay one row with compact brand/spacing rather than stacking rows; all actions remain reachable at 320/390px and desktop. Preserve >=44px vertical targets and visible keyboard focus.

## Acceptance → proof

| ID  | Given/when/then                                                                                                                                        | Verification                                                                                                           | Evidence             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | -------------------- |
| N1  | Home and game routes display one top nav, no vertical rail or secondary header/nav; order is Rules, Rank, My Runs, auth, primary Play.                 | Real rendered shared-header SSR regression and desktop in-app browser inspection.                                      | Passed; limits below |
| N2  | Member with an active run navigates elsewhere then clicks Play: original run resumes; no setup modal or create request.                                | Disposable Postgres synthetic active fixture, real Better Auth browser navigation and persisted identity/count.        | Passed; limits below |
| N3  | New run is absent globally and present only in Play content when creation is allowed. Click opens existing setup; empty active run cannot be replaced. | Existing canCreateNewRun regressions + browser no-run/used-run/empty-run states; don't create paid environments.       | Passed; limits below |
| N4  | Signed-in/out action remains correct across home/game; guests can open existing sign-in flow; nav destinations/current state work.                     | Existing auth regression plus actual browser routes/session state.                                                     | Passed; limits below |
| N5  | At desktop and 390/320px header is one row, no clipped actions/sidebar, keyboard focus visible.                                                        | In-app browser visual inspection and DOM geometry when browser supports resizing; disclose unavailable viewport proof. | Passed; limits below |
| G1  | No regression or unrelated source changes; intended feature committed.                                                                                 | npm run check, npm run test:coverage for changed tests, git diff --check, independent review, commit hooks.            | Passed; limits below |

## Execution

1. Read AGENTS.md, docs/verification.md and installed Next docs for client components/Link. Independent plan approval before source/test edits.
2. Add minimum meaningful failing SSR/header regression before implementation. Developer owns `app/site-header.tsx`, `app/page.tsx`, header/new-run hunks in `app/game-ui.tsx`, affected `app/globals.css` sections and targeted tests. No auth-action/backend changes unless raised to lead first. Use exact feature CWD for all commands; prior auth developer accidentally checked primary and lead caught it.
3. Implement shared row, preserve openPlay resume logic and guarded setup. Browser-check using disposable Postgres and synthetic env only; intercept only Resend. No shared `.env.local`, paid model/Sprite calls, or live email. Coldtea QA starts with qa_capabilities; existing GitHub prerequisite may block automated run, in which case report that limitation and inspect directly in-app.
4. Lead independently reruns gates and browser checks. Developer proposes only useful concrete simplification. Reviewer audits full diff/evidence; allow at most one scoped P0–P2 corrective cycle, then re-review. Record evidence, stage only owned paths and commit with hooks. Keep worktree until an authorized merge.

## Evidence

- Independent plan review APPROVE (GPT-6.1/high). Developer GPT-6-Luna/medium; scoped files only. Baseline `e1443e7`; primary and prerequisite auth worktree clean.
- TDD: extended real Home SSR test first; failed with `landing has one main navigation row` before header implementation. Green asserts actual rendered order/destinations/primary styling class and pending auth state. No auth decisions mocked.
- N1/N4: actual in-app browser home, Rules, Rank, My Runs and Play show one header in requested order; member Sign out present; no global New run. Clicked Rules and Rank links with matching content/URLs. Shared header uses existing AuthAction and existing openPlay handler.
- N2: disposable real Postgres member fixture `00000000-0000-4000-8000-000000000002` with persisted user event `NAV QA persisted active run`; visited Rank then Play and saw same transcript and instruction composer without setup modal. SQL remained one active run with same ID. No environment creation or inference requested. Initial fixture was inserted after app loaded no-run state, so reloaded once before testing navigation.
- N3: used-active run on /play shows content New run; click opens existing Start a new run setup with warning, no create executed. New run absent on Rank/Rules/history. Removed only fixture event, reloaded /play: empty-active run resumes with first-instruction prompt and no New run, preserving replacement guard.
- N5: first 320px real-app iframe screenshot revealed overlapping full wordmark and outline-only Play. Lead caught and developer fixed compact accessible PTF branding, obsolete overriding CSS, filled CTA specificity, and workspace flex fill. Rechecked 320px member Play and 390px member home: all five actions fit a single row without overlap; CTA visibly filled. Real application rendered inside fixed-width iframe (not mocked/static UI). Desktop/keyboard checks are recorded below.
- Lead `npm run check` passed lint/format/typecheck and 38 tests. `npm run test:coverage` passed (all-source 22.92% lines; not a deployment claim). Raw logs: `.artifacts/navigation-qa/lead-check.log`, `lead-coverage.log`; developer logs alongside. `git diff --check` passed.
- Safety: actual Better Auth handlers/migrations/cookies on disposable Docker `ctf-nav-qa` / database `ctf_nav_qa`, all synthetic credentials, validated intercepted Resend recipient `navigation@example.invalid`; no live email/Sprite/model service calls. Server log pane `Jasmine`. Temporary iframe server on31002, app3002.
- Automated Coldtea QA attempted once with idempotency key `mqcr_top_navigation_20261009`: 400 GitHub connection prerequisite, no run started. Direct browser checks are not claimed as automated QA. CUA browser resizing unavailable; fixed-width real-app frames used instead.
- Independent final full-diff review APPROVE, no P0–P2 findings. Authorized feature commit follows this recorded evidence. No merge/push/deploy.

### Final checks and cleanup

- 1280px real-app Rules viewport inspected via fixed-width iframe scaled to fit the in-app pane: full brand, all five actions, one row, filled Play. At320/390 the compact PTF brand avoids overlap. Content headers may wrap; global nav does not.
- Keyboard Enter on Home Rules link navigated correctly to /rules. Existing `:focus-visible` rules retained unchanged. A distinct focus-ring appearance was not visually established by tool-driven Tab; this remains a disclosed manual-proof limit, not an accessibility change.
- Signed-in Sign out clicked on Rules -> Sign in. Signed-out Home Sign in clicked -> `/play?signin=1`, existing email field and send-link button observed. No email sent. N4 passed with real Better Auth.
- Reviewer GPT-6.1/high approved full feature after all source changes; no P0–P2. No further simplification justified. Lead check/coverage and diff-check passed; pre-commit hooks will run normally. All checks used the feature CWD and Node24.
- Feature Next server and temporary viewport server stopped; disposable Postgres container removed. Synthetic QA env/logs retained only in ignored `.artifacts/navigation-qa/`. Restored feature `.env.local` to the worktree helper's usual private copy of primary credentials after QA; no server/check that accesses those services was launched afterward.
- User-authorized commit only. Primary and prerequisite auth source worktree unchanged; no merge, push, deployment or worktree removal. Final commit ID is reported in the delivery message, not self-recorded here.
