# Run navigation corrections

Worktree: `/Users/jonathan/Code/ctf/.worktrees/run-navigation`
Branch: `codex/run-navigation`
Baseline: `3e1bdab2b1276c1cccfa259bf25d3f648d284eb0`; initial index and worktree clean.

## Scope and assumptions

Address all four browser comments with UI-only changes. Existing status active + unexpired season defines continuation; busy temporarily disables input but does not make a run historical. No new expiration policy, provisioning API restriction, billing change, or host-browser modification. No instructions means no persisted user event (optimistic id -1 does not count). Prevent replacement of an empty continuable run; allow recovery from an ended/expired empty run. Hide/disable New run on such a run and guard setup submission. Preserve existing ongoing work, ownership/request guards, fork behavior and direct run URLs.

Play nav must settle at `/play`, showing the remembered run without redirecting to its detail URL. Explicit run selection/start/fork retain `/runs/:id`. My runs, Rank, Rules settle at `/runs`, `/rank`, `/rules`. Browser Back/Forward must render matching content. Existing My runs navigation already changed browser snapshot URL in reproduction; the embedded address-bar issue was subsequently confirmed as a Coldtea host synchronization defect (see evidence).

## Criteria and proof

- C1: `/play` selects Play; active unexpired `/runs/:id` selects Play, even before Continue is clicked. Busy active run remains selected. Detail loading/missing/error has no selected item.
- C2: `/runs` alone selects My runs; ended/captured/exhausted/creating/season-expired details select none. Rank/Rules select themselves.
- C3: Empty continuable run hides and disables New run and cannot invoke creation through an already-open setup dialog; persisted instruction restores it after busy clears. Optimistic-only user event does not unlock creation. Ended/expired empty run can recover with new run. Initial no-run state still permits creation.
- C4: Nav clicks settle at canonical URLs above. `/play` loads remembered run on reload and refreshes it on return; failed refresh has visible retry, not silent failure. Navigation never creates a Sprite. Run deep links and Back/Forward continue working; stale requests cannot move the view.

Mapping: C1/C2/C3 table-driven tests of actual owned UI decisions plus SSR where feasible; C4 actual browser navigation + existing routing tests. All: `npm run check`, `npm run test:coverage`. Browser inspect changed app in in-app browser, using disposable local Postgres/synthetic auth only for new automated fixtures; no shared credentials or paid provisioning/inference. Read `qa_capabilities` (done) before any QA run. Unavailable safe browser fixtures/remote QA prerequisites must be reported, never called passing.

## Steps and ownership

1. Independent read-only plan verification → resolve blockers.
2. Developer owns `app/game-ui.tsx`, narrowly required rail CSS, and focused tests/helper if needed. Trace all relevant callers; read installed Next docs first. Add meaningful failing regression before fix → pass it. Prefer existing helpers/native Links; do not replace race protection with simplistic state.
3. Lead owns this contract, safe local test environment, raw verification and browser inspection. No unrelated source edits. Run gates and review changed lines.
4. Independent reviewer checks full baseline diff and evidence. At most one bounded corrective cycle for P0–P2. No push, merge or deployment. Commit only verified intended changes.

## Evidence

- Baseline browser: opening reported run then clicking My runs displayed list and snapshot URL `/runs`; server pane Darjeeling logged real `/runs` GET.
- Source: detail rail hardcoded to history; openPlay and `/play` effect route to remembered `/runs/:id`; New run only disabled by busy.
- Checks and final browser evidence: completed below.

### Baseline and safe browser setup

- Node 24 baseline `npm run check`: 26 passed, zero failed.
- Disposable Docker Postgres `ctf-run-nav-qa`, loopback port 32867/database `ctf_run_nav_qa`; real schema and Better Auth migrations. Worktree private `.env.local` replaced with synthetic QA values (primary untouched). Existing real-pool injection seam used by ignored `.artifacts/preload.mjs`. External fetches denied except strict synthetic Resend interception; no Sprites or inference provisioned. Real magic-link sign-in and synthetic seeded runs used in actual Next app on port 3005 (pane Chamomile).
- Reproduced empty active run: My runs highlighted and New run enabled. Screenshot inspected.
- Confirmed Coldtea host issue through native accessibility: after Rank click document URL changed to `localhost:3005/rank` and leaderboard rendered; Address bar retained prior `/runs/00000000-0000-4000-8000-000000000001`. App-side router already changes actual URL; host address synchronization is outside this repository. Do not introduce full-page navigation as a workaround.

### Implementation verification

- Worker regression: restored baseline decisions (detail → history, always permit creation); focused assertions failed history !== play and true !== false. Fixed predicates pass 2/2. No missing-export failure counted.
- Lead final npm run check: 28/28 passed, lint/format/typecheck passed. A preceding concurrent test run collided on a temporary worktree-test port (EADDRINUSE); sequential rerun passed without source changes.
- Lead npm run test:coverage: passed 28/28; all-source lines 20.88%, branches 79.63%, functions 45.45%. UI effects are not covered by offline helper tests; browser proof below complements them.
- C1/C2: real empty active detail and historical active detail before Continue visibly select Play (screenshots inspected); ended detail selects none. Current empty run blocks New run even on My runs or another historical detail. Unit table covers busy, creating, captured, exhausted, ended, expired/missing details and canonical tabs.
- C3: persisted instruction made New run visible/enabled. With setup already open, removing the synthetic persisted instruction while existing billing polling ran hid New run and disabled creation. A separate stale-dialog test stopped polling, removed the instruction in the disposable database, then clicked still-enabled Create: fresh GET rejected it with visible message, no POST/provisioning, row count remained exactly three. No real instructions submitted to models or Sprites.
- C4: clicked My runs → /runs, Play → /play, Rank → /rank, Rules → /rules; Back returned Rank and Forward restored Rules. Fresh document navigation to /play retained /play and loaded remembered run. Real disposable database table temporarily renamed to induce GET 500: Play settled at /play with Retry Play; restore and retry recovered. Host reload tool also follows stale committed URL, so direct document navigation tested reload semantics instead.
- Raw browser snapshots saved in ignored .artifacts/browser-evidence.json; server logs inspected directly in pane Chamomile. Repeated Fast Refresh/auth fetches during development reached real BetterAuth rate limit; cleared only disposable QA rate-limit records and repeated affected scenario successfully.
- No paid qa_run_start, live-service smoke, or deployment promotion run. In-app browser inspection was performed against real local Next/Auth/Postgres; no fake app/SQL/auth/route decisions.
- Simplification: reused existing rail buttons, displayGame and request guards; no new component, dependency, stylesheet, or backend policy.
- Additional C4 proof: actual busy lease fixture remained visible/disabled across My runs → Play with URL /play; no active model/SSE was invoked, so this is lease/polling UI proof, not live inference smoke. After releasing lease, held a real ACCESS EXCLUSIVE database lock for 12 seconds, clicked Play then Rank before completion; old run GET took 10.9 seconds (pane Chamomile), but final URL/content remained /rank after response. Raw snapshots appended.
- Additional C2: moved historical fixture to a real expired season; detail showed season-closed message and no aria-current nav element (browser selector check).

## Final status

C1–C4 app behavior verified; independent full-diff reviewer approved with no P0–P2 findings. Coldtea host address-bar synchronization remains outside this repository. Live SSE/provider/Sprite smoke and paid remote QA were not run; no deployment promotion is claimed. No earlier checkpoint commits; this feature is retained on codex/run-navigation, not merged or pushed.

## Follow-up: guest-start readiness race

Baseline for this correction: 72b938f. Same worktree /Users/jonathan/Code/ctf/.worktrees/run-navigation and branch codex/run-navigation; clean initial state. No merge/push authorized.

R1: starting from a fresh guest session, complete run creation, persist an instruction and finish/fail its response: New run becomes visible/enabled without reloading. R2: the newly-created empty run and optimistic-only instruction remain protected. R3: unknown run/auth state, account switching, preflight checks, ongoing-response disablement and existing navigation remain safe.

Investigate exact guest adoption/readiness timing with temporary client logging and real browser reproduction. Prefer eliminating a redundant readiness requirement when an authoritative game is already loaded, or restoring readiness on creation success; choose the smallest complete mechanism after evidence. Developer owns app/game-ui.tsx and focused regression tests only; lead owns this plan and ignored disposable browser harness. Independent verifier/reviewer remains read-only. No fake auth/SQL/routes: real local Postgres and Better Auth, strict external Sprite/OpenRouter boundary fakes only. Retain running user preview on 3005, use separate Next distDir and QA port for reproduction if possible. Prove red/green from real browser, run focused regression plus npm run check and test:coverage, then remove temporary app logging and independently review.

### Follow-up evidence

- RED: real fresh anonymous guest on QA port 3006; delayed real session request 1.5s and strict fake remote Sprite provisioning 4s. Readiness log: preflight true → guest-owner adoption false → successful POST remains false → actual persisted user event and real Pi response completion still false. Browser confirmed New run hidden/disabled. Raw .artifacts/guest-red.log and guest-snapshots.json.
- Fix: restore readiness immediately after successful setGame(next), protected by existing epoch/startId guards. No eligibility relaxation, new abstraction or service/backend change.
- GREEN: identical timing with another fresh anonymous session; creation success restored readiness true. Empty run stayed hidden/disabled; accepted instruction made New run visible but disabled during response; completion made it visible/enabled WITHOUT reload. Clicking it opened an enabled setup dialog. SQL confirmed one persisted user event for the green run. Raw .artifacts/guest-green.log and snapshots; screenshot inspected in Coldtea.
- Browser used real Next/Better Auth/Postgres/routes/SSE/Pi with strict Sprite and OpenRouter external-boundary fakes only; no shared-data modifications or paid calls. First attempted separate Next dev instance was rejected by Next's directory-level lock; preview 3005 was temporarily stopped for QA and must be restarted afterward. No .env.local modifications. One earlier green attempt was invalidated by developer HMR, discarded and repeated after source freeze.
- Existing predicate regression explicitly covers readiness true with empty vs accepted user event; actual race red/green is browser evidence, not claimed covered by pure predicate test. Temporary client logging removed after diagnosis.
- Final offline gates: npm run check and npm run test:coverage both passed 28/28; all-source coverage 20.88% lines, 79.63% branches. Diff check passed. No useful simplification beyond the single readiness setter. Disposable QA server/database stopped; original preview environment preserved.
- Independent correction review approved with no P0–P2 findings. Normal worktree dev preview restarted and inspected at http://localhost:3005/play; pane Rooibos. Main unchanged (pre-existing .env.example modification belongs to other work); no merge or push.

## Pull request preparation

At user request, merged origin/main at 3988d27 into the feature branch without conflicts (merge a4bb582). Post-merge npm run check and test:coverage passed 38/38; all-source line coverage 21.42%, branches 79.85%. Prior browser and independent-review evidence applies to unchanged UI delta. No production migration or deployment was run. PR Lens document validated and SVG rendered/inspected locally; hosted canvas publishing failed with CANVAS_UNAVAILABLE/TLS connection failure, and installed gh 2.96 lacks --attach. Generated diagram remains ignored locally, not committed.
