# Direct sign out

- Worktree: `/Users/jonathan/Code/ctf/.worktrees/direct-sign-out`
- Branch: `feature/direct-sign-out`
- Baseline: `2c90af8cce34ddd569c0fbd90e0a29d54e75ec1f`; initially clean index/tree.
- Scope: replace signed-in Account modal entry with direct Sign out; make home header session-aware too. Preserve anonymous/no-session sign-in navigation/modal, login delivery, run ownership and billing.
- Non-goals: provider/config changes, account settings, redesign, database schema changes, deploy/merge/push.
- Ownership: developer owns `app/auth-action.tsx` (small shared client header action), `app/page.tsx`, relevant header/modal hunks of `app/game-ui.tsx`, and targeted existing/new tests. Lead owns plan and disposable QA setup. No new dependencies.

## Acceptance and checks

| ID  | Given / when / then                                                                                                                                                   | Check                                                                                   | Evidence                                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| A1  | Member opens /runs: header says Sign out, not Account; clicking ends session without opening a modal and clears account-owned displayed state.                        | Real Better Auth + disposable Postgres browser path; reload must stay signed out.       | Passed; see evidence/limits below                         |
| A2  | Member opens /: header says Sign out, not Sign in; click ends session and restores Sign in.                                                                           | Same browser path using real member session.                                            | Passed; see evidence/limits below                         |
| A3  | Guest or no session: game Sign in opens existing email form; home Sign in retains /play?signin=1 navigation.                                                          | Browser inspection, existing landing regression.                                        | No-session passed; anonymous not run                      |
| A4  | Sign-out request fails: show error, allow retry, do not claim success or clear signed-in state. While session is loading do not show a misleading actionable Sign in. | Focused real component or browser proof with transport failure; no auth decision mocks. | HTTP error + loading passed; thrown network error not run |
| G1  | Owned changes pass offline gates and no unrelated edits.                                                                                                              | npm run check; npm run test:coverage if tests changed; independent diff review.         | Passed; see evidence/limits below                         |

## Implementation

1. Independent read-only plan review; resolve blockers before source edits.
2. Baseline browser regression on actual app with disposable local Postgres, synthetic credentials, intercepted Resend only. No shared .env.local, paid services or live email. Use Coldtea QA for e2e when available; otherwise report missing e2e proof honestly. Read relevant installed Next client-boundary docs before writing code.
3. Minimum shared client action for two header callers. Reuse authClient.useSession/signOut; callback only on confirmed success for GameUI cleanup. Preserve home server-rendered content. Avoid new generic helpers/test framework. Remove only newly orphaned signed-in modal content. Record a failing regression before implementation, then passing evidence.
4. Lead runs checks and in-app browser inspection; developer identifies only concrete simplifications; independent full-diff review. No commit, merge, push or deployment without authorization.

## Risks and limits

Cookie-session loading and anonymous sessions must not be mistaken for member login. Shared action must not clear the UI on failed sign-out. Worktree helper copies credentials: replace the feature QA environment with synthetic values before running a server. Existing user-facing localhost:3003 remains untouched until an authorized merge. Keep worktree for review.

## Verification evidence (2026-10-09)

- Independent plan review: GPT-6.1, high reasoning, APPROVE before developer edits.
- Baseline red: real Better Auth member session in in-app browser on isolated `http://localhost:3001/runs` displayed `Account` and no `Sign out`; same session on `/` displayed `Sign in ↗`.
- A1 passed: after edit, `/runs` displayed `Sign out` and a persisted synthetic ended run. Click returned HTTP 200 from real `/api/auth/sign-out`; header became `Sign in`, run disappeared and signed-out guidance appeared without any modal. Reload preserved signed-out state. SQL verified sessions=0, retained_runs=1 (no data deleted).
- A2 passed: signed-in home displayed `Sign out`, not a Sign in link; click signed out and restored `/play?signin=1` link. SQL verified sessions=0.
- A3 passed for no-session state: clicking home Sign in navigated to `/play?signin=1`, with email field and `Email me a sign-in link` button. Game header restored Sign in after logout. Anonymous-state classification uses the existing `isAnonymous` field; a distinct anonymous-session browser run was not performed.
- A4 passed for actual HTTP error: prefilled the disposable database's real per-path sign-out rate bucket, clicked home Sign out, observed HTTP 429 and `Too many requests. Please try again later.`; button remained Sign out and SQL sessions=1. Removed only that QA rate bucket and retried; HTTP 200, Sign in restored, sessions=0. No auth/session decision mocked. Loading SSR regression asserts disabled Loading button and absence of actionable Sign in link; network-throw branch not separately exercised.
- G1 lead rerun: `npm run check` passed all 38 tests, lint, format and typecheck; `npm run test:coverage` passed. Raw output: ignored `.artifacts/sign-out-qa/check.log` and `coverage.log`. `git diff --check` passed. Node 24.16.0.
- Developer's initial pass report was invalid because checks accidentally ran in the primary checkout. Lead caught formatting failure in feature checkout, developer corrected formatting and landing SSR test, then lead independently reran the feature gates successfully. No primary source edits were made.
- Safety: disposable Docker `ctf-signout-qa`, `ctf_signout_qa` database, synthetic env, real Better Auth migrations/handlers/cookies, only Resend intercepted with validated synthetic recipient. No Sprite or model calls and no real email. Application HTTP logs read from Coldtea `Chamomile` pane.
- Coldtea automated QA prerequisite blocked: `qa_run_start` returned 400, `Connect GitHub so your TeaHouse shares one QA project for j-pollack/ctf-demo.` No run started. Direct in-app browser checks above are not a claimed automated QA run.
- Final independent full-diff review: GPT-6.1 high reasoning APPROVE; no remaining P0–P2 findings. No commit, merge, push or deployment authorized/performed. Original localhost:3003 remains unchanged.

### Bounded review correction

Reviewer found one P2: retained `?signin=1` re-opened login on logout. Lead reproduced this on `/runs?signin=1` using a real member session: Sign out returned 200 but displayed the email modal. Developer added a one-time query-consumption ref after initial session resolution and closes a guest login modal when membership appears. Lead reran the exact browser scenario: Sign out became Sign in, history cleared, and no dialog or email field appeared. Full check and coverage rerun passed (38 tests). This is the single automatic corrective cycle; final re-review APPROVE with no remaining P0–P2 findings.

QA cleanup: stopped the feature-only Next server and temporary proxy; removed the disposable Postgres container. Synthetic-only feature `.env.local` and ignored QA logs remain for reproducibility; no shared credentials were used. Feature worktree remains uncommitted for review, primary checkout clean.

User authorized committing on 2026-10-09. Verified auth changes are being checkpointed before the separate horizontal-navigation feature; no merge/push/deploy authorized.
