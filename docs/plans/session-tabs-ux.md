# Session tabs and game layout

Worktree: `/Users/jonathan/Code/ctf/.worktrees/persistent-run-sessions`
Branch: `feature/persistent-run-sessions`
Baseline: `e9ec34145b01607baee347eb3680227b5e4623fe`; clean index and worktree.

## Scope and approach

Replace the session dropdown with visible tabs and inline session creation. Tabs preserve readable transcripts at any session count and reuse the existing selected-session lifecycle. Keep the terminal visual language, make the objective and shared stakes visible, and reduce configuration clutter with a disclosure. Keep budget, pending billing, advisory risk and terminal outcomes honest. Do not change backend behavior, add dependencies, introduce a split-view mode or alter billing/monitoring. Reuse this registered feature checkout because this is feedback on its existing multi-session feature.

Lead uses inherited GPT-6 high-reasoning execution; independent verifier/reviewer uses GPT-6.1 Sol high; scoped developer uses GPT-6 Sol medium.

## Criteria and evidence

- C1: One or many sessions appear as visible tabs with selected and running status. Inline new-session control retains current pending/error/terminal guards. Verify browser creation and switching plus component regression.
- C2: Switching preserves per-session draft, model/system settings and streaming; sending and Stop affect selected session. Existing session-state regressions plus browser two-session draft and running switch checks.
- C3: Configuration is reachable but collapsed by default. Shared budget, pending charges, objective and monitor risk remain clear. Browser desktop screenshot and settings interaction.
- C4: At mobile width, tabs scroll without document overflow, composer and controls remain reachable; keyboard navigation and selected-tab accessibility work. Browser mobile and keyboard check.
- C5: Caught/terminal runs retain all session transcripts but prevent new session and instructions. Browser controlled catch and existing state tests.

## Checklist

- [x] Inspect baseline, relevant UI, repository verification strategy and Next CSS guide.
- [x] Independent plan approval.
- [x] Implement scoped UI/CSS and regression.
- [x] Lead runs `npm run check` and browser scenarios using disposable local Postgres and strict external-service fakes.
- [x] Independent full-diff review and record evidence.

Owned implementation files: `app/game-ui.tsx`, `app/globals.css`, optional focused session-tabs component and tests. Lead owns this plan and local QA artifacts. Preserve user server on port 3002. No live spending, commits, push or deployment for this UI task.

## Completed evidence

- C1: Browser created three sessions, including one while a sibling was running. Selected tab has keyboard navigation and panel linkage. Overflow creation and direct URL reload reveal Session 3 with strip scrollLeft 63.
- C2: Browser retained separate drafts, switched during a held agent command, created an independently editable session and stopped the selected agent. Existing session-state tests passed.
- C3: Browser verified model/effort editing, monitor locks after the first turn, collapsed settings and an unsaved prompt badge. Compact budget remains run-wide. Risk, chart and decisions identify the selected session.
- C4: At 390x844 there is no document overflow and composer bottom is 836px. With both settings disclosures open and prompt enlarged to 40dvh, settings scroll internally. At 390x568 composer bottom is 560px. Arrow and End navigation selected and focused the expected tabs.
- C5: Controlled catch attributed Session 3, removed composer and creation, cleared running indicators and retained all three transcripts. Earlier session transcript and read-only settings remained available.
- `npm run check`: lint, format, typecheck and all 137 tests passed. `npm run test:coverage`: all 137 tests passed. `git diff --check` passed. Focused regression was recorded red before the tab component implementation and green afterward.
- Independent review approved after one corrective pass. No outstanding P0–P2 findings. P3: desktop-to-mobile resize can partially hide the selected tab until the player scrolls the strip; selection changes, creation and direct loads reveal it automatically.
- Evidence: `.artifacts/qa-session-tabs/first-pass-proof.json`, `corrections-proof.json`, `check.log`, `coverage.log`, `final-desktop.png`, `final-mobile.png`, `expanded-settings.png`, `caught-mobile.png`.
- QA used real Next/Postgres/Better Auth/Pi with controlled external boundaries. First pass blocked Next telemetry attempts; final pass disabled telemetry and recorded zero unexpected calls. Disposable QA browser/server/database cleaned up. User server on port 3002 preserved.
- No commits, push, live-model evaluation or deployment performed. No backend changes.

## Run-wide risk correction

User clarified that advisory risk is run-wide and requested overlaid session graphs plus the maximum across sessions. User authorized committing all current work after verification. Previous selected-session labeling decision is superseded.

Scope: add compact per-session per-turn peak risk histories to existing session summaries in the authorized run response, derived from persisted monitor events. Merge local streamed monitor events into those series by session/turn using maximum so tab selection cannot lower the value. Overlay labeled SVG traces against a common turn-number axis; percentage is the peak across all traces. Keep investigator decisions independent and preserve scoped receipts. No full sibling transcript fetching, new endpoint, schema migration or dependency.

Criteria R1: unvisited sibling risk included on initial/reload and incremental selected-event reads; SQL parameterized and run-scoped. Real Postgres integration regression with two runs and multiple sessions.
R2: run peak equals maximum of any session/turn, stable on tab switches; live events can raise it without dropping persisted history. Pure regression.
R3: overlaid distinguishable session traces, legend and axes, empty/single-point and different-length series remain readable; no misleading click navigation into wrong session. SSR and desktop/mobile browser checks.

Checklist: plan verification, scoped implementation with red/green regressions, offline check and coverage, disposable Postgres integration, browser inspection, independent review, authorized commit. Ownership: developer owns risk query/types/chart/UI and focused tests; lead owns plan and QA. Preserve all uncommitted tab-UX files. Record final evidence below before commit.

## Follow-up experiment design

User requires correlating transcripts only by user/API-key owner, without a workspace/run/Sprite identifier supplied as a grouping clue. Current investigator retrieval is run-scoped and therefore supplies workspace membership. The required follow-up retrieves user-scoped history containing unrelated as well as related workspaces and infers filesystem relationships from transcript evidence. Internal run/Sprite IDs remain for execution, accounting and teardown, but retrieval must not silently group by them either. This is a separate design follow-up; no investigator retrieval or authorization change is included here.

Lesson: shared-run telemetry must cover unvisited sessions. Labeling a selected-session subset accurately does not satisfy a run-wide metric requirement.

## Run-wide risk evidence

- R1: Real Postgres integration passes with unvisited sibling peaks, duplicate monitor events, missing-turn bucket, empty session, unrelated run exclusion and a selected transcript cursor beyond all events. Compact histories arrive on reload without sibling transcript downloads.
- R2: Browser reproduced the original 20% display in Session 1 despite Session 2 recording 80%. After the fix, fresh Session 1 reload shows 80%; later background Session 2 events raise it to 95%. Creating and reloading empty Session 3 keeps 95%. Pure tests cover persisted/local maxima, immutability and foreign-session exclusion.
- R3: Desktop/mobile browser inspection shows overlaid traces, distinct dash/marker styles, per-session peak legend, pre-turn handling and a common agent-turn axis. Empty sessions say No reviews. At width 390px document width remains 390px and chart width is 324px. Chart accessible-summary and crowded-axis regressions failed for their intended assertions before correction and passed afterward.
- Initial complete gates: 139 offline tests including lint/format/typecheck and coverage passed. Disposable Postgres integration passed 144 tests in `risk-integration.log`. The new chart module's initial missing-module failure was a setup failure, not behavioral TDD evidence; browser red/green and the later chart assertion failures provide actual regression evidence.
- Final raw evidence: `.artifacts/qa-run-risk/proof.json`, `desktop.png`, `mobile.png`, `check.log`, `coverage.log`; `.artifacts/qa-session-tabs/risk-integration.log`, `risk-chart-red.log`, `risk-chart-green.log`. Final QA harness recorded zero unexpected external calls.
- Pre-commit security review: no secrets added; risk query uses the existing authorized run boundary and parameterized game ID; numeric JSON fields checked before casts; graph text remains React-escaped. No new endpoint, input boundary, state-changing request or authentication path.

Final gates after correction: `npm run check` passed all 140 tests plus lint/format/types; `npm run test:coverage` passed all 140 with 33.49% all-source line coverage. Independent reviewer approved with no P0–P2 findings and independently ran 17 focused tests. Earlier 144-test real-Postgres integration remains applicable because the final correction changed only chart presentation/tests. QA browser/server/database cleaned up; port 3002 preserved. User authorized commit of the complete tab/risk UI delta; push is not authorized in this turn. The existing P3 desktop-to-mobile selected-tab scrolling limitation remains.
