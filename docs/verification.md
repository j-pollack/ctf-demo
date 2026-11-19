# Verification audit and test strategy

Audited September 30, 2026. The current offline suite is fast, but it is not deployment proof: most orchestration, persistence and HTTP handling remain untested. Keep pure unit tests on every commit, real-component integration tests on every PR, and a small real-service smoke/e2e suite as a deployment gate.

Implemented: Oxc lint/format hooks, coverage reporting and the first deterministic Sprite orchestration integration suite. The remaining unit/auth/accounting restructuring and coverage gates below are proposed next work. No live Neon, Sprite, Resend or OpenRouter checks were run; the new integrations use disposable local Postgres and external-service fakes.

## Current commands and runtimes

Measured on macOS arm64 with Node 24.16.0, installed dependencies and warm caches. Times include npm/process startup; offline medians use three sequential runs. They are local observations, not CI budgets.

| Command                            | Local wall time | What it verifies                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run lint`                     | 0.14 s          | Oxlint core correctness rules with TypeScript, Unicorn and Oxc plugins; warnings fail                                                                                                                                                                                                                                                                          |
| `npm run format:check`             | 0.23 s          | Oxfmt checks supported source/config/docs files, respecting ignores                                                                                                                                                                                                                                                                                            |
| `npm run typecheck`                | 0.34 s warm     | Strict TypeScript checks; nonincremental median 0.83 s                                                                                                                                                                                                                                                                                                         |
| `npm test`                         | 0.91 s          | 11 tests in five files; no live services                                                                                                                                                                                                                                                                                                                       |
| `npm run check`                    | 1.73 s          | All four offline gates above                                                                                                                                                                                                                                                                                                                                   |
| `npm run build`                    | 3.14 s          | One warm production build; bundling, Next type validation and route compilation, not live HTTP behavior                                                                                                                                                                                                                                                        |
| `npm run test:coverage`            | 1.71 s          | Same offline tests with source-mapped, all-source coverage                                                                                                                                                                                                                                                                                                     |
| `npm run check:budget`             | Not measured    | Real Postgres concurrency, billing holds/settlement/refunds/reconciliation and lease checks; provider generation response stubbed for its fixture                                                                                                                                                                                                              |
| `npm run check:auth`               | Not measured    | Real Better Auth handlers and Postgres; anonymous-to-member transfer, single-use magic link, $3 upgrade, private per-monitor leaderboards; outbound email intercepted                                                                                                                                                                                          |
| `npm run smoke -- --messages-only` | Not measured    | Real Postgres, Pi SDK and two Sprites; controlled completion responses exercise shared-Sprite sessions, switching, pending billing, async worker review, capture, exhaustion and cleanup                                                                                                                                                                       |
| `npm run smoke`                    | Not measured    | Adds live model inference: streamed agent usage, readable reasoning, leases and concurrent cap admission; it proves one real flag-read catch through the monitor worker with the live classifier and investigator, and does not prove monitor error handling or that the live monitor allows a harmless run; the async section's monitor calls stay controlled |
| `npm run setup`                    | Not timed       | Schema/auth migration operation, not a test; changes the configured database                                                                                                                                                                                                                                                                                   |

The new `npm run test:integration` completed in a local median of **5.29 s**, including container startup/removal (three successful runs). Its coverage run reports **100% lines / 85% branches for `lib/sprites.ts`**, 91.37% lines for `games.ts`, and 91.33% for `runner.ts`; these are integration-only results, not combined coverage or proof of live isolation.

No repository CI workflow or saved browser/e2e test definitions were found. `npm run test:integration` now runs the local Sprite suite; the existing live auth/budget scripts are not included. Smoke scripts exercise backend functions directly, not the deployed Next HTTP/SSE/browser path.

### Existing offline tests

| File                         | Count | Classification and coverage                                                                                                                                                                                              |
| ---------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests/game.test.ts`         | 5     | Mixed unit checks: flags and strict fail-closed monitor parsing; transcript repair/provider replay and model switching; pricing/admission arithmetic; monitor prompt hash and difficulty contract; pre-aborted inference |
| `tests/inference.test.ts`    | 2     | Diagnostic redaction/truncation; model capability checks with a stubbed catalog fetch                                                                                                                                    |
| `tests/message-flow.test.ts` | 1     | Genuine in-process SDK integration: real Pi session/resource loader/runtime, fake model stream and shell tool; checks prompt isolation and replay across turns                                                           |
| `tests/transcript.test.ts`   | 2     | Component integration: real React SSR/Markdown rendering; speakers, tool display, blocked/error decisions and unsafe HTML/links/images                                                                                   |

The concurrently added `tests/worktree.test.ts` contributes one additional filesystem/Git/local-socket integration test for port reservation, private credential copying and checkout pruning. It uses no external services.

The unit assertions are useful, but importing `games` and `runner` also loads DB/SDK dependencies. They do not yet have a clean pure-unit dependency boundary. SSR coverage does not exercise GameUI effects, input, cancellation or streaming.

## Hook behavior and proof

Husky installs via `prepare`. Pre-commit runs lint-staged (staged JS/TS lint and staged supported-file formatting checks), then whole-working-tree typechecking and offline tests. It is intentionally check-only. Build, coverage and service checks are excluded to keep commits fast and deterministic.

An isolated temporary Git repository verified a real successful commit, empty staged input, formatting/lint/type/test rejection, and partially staged files. Staged violations cannot be hidden by corrected unstaged content; unstaged-only lint violations are ignored by staged lint, and the index/worktree are preserved. Typecheck/tests deliberately see the full worktree, so local unfinished changes can still block a commit. The real repository index was not modified for this proof.

Formatting establishes a whole-repository baseline. Initial GameUI and transcript fixture SSR markup matched the pre-format source exactly; the stylesheet matched formatter output from the original source, and the static preview was inspected in the in-app browser. This is visual formatting validation, not interactive e2e coverage.

## Implemented Sprite integration suite

Run `npm run test:integration`. Docker must be running with `postgres:17-alpine` already cached; prepare it once explicitly with `docker pull postgres:17-alpine`. Runs use `--pull=never`, bind one fresh container to a random loopback port and create a uniquely named database. The runner excludes shared credentials/preload options, never reads `.env.local`, and removes its container after success, failure or handled interruption. Direct test execution rejects non-loopback/non-test database names and refuses any database with an existing `ctf` schema. The runner's reporter (`scripts/test-integration-reporter.ts`) holds each test file's process output, such as inference and failure logs from the code under test, and prints it only when a test in that file fails.

Routine monitor timing scenarios inject 3-second investigator and 1-second classifier budgets, retaining native cancellation, real 120-second SQL claims and persisted billing/coverage assertions. Pure tests pin production defaults at 90/15/120 seconds. `npm run test:integration:timing` is an opt-in, roughly 90-second production-worker deadline check with the default budgets, disposable Postgres and synthetic external responses; it needs no paid credentials. The runner selects only that scenario and does not accept timing overrides from the environment. This check does not replace live-service deployment smoke.

`tests/integration/sprites.test.ts` contains 39 scenarios (Node reports 40 tests including the parent). It exercises real `startGame`, `cleanup`, `claimGame`, `runGame` and Sprite adapter functions, real Postgres schema/migrations/transactions, and real Pi sessions. Only the Sprite SDK's remote create/policy/exec/delete operations and OpenRouter responses are stubbed. Existing pool injection supplies a real local `pg.Pool` without changing production TLS or application code.

Covered outcomes: private setup and policy-before-initialization order; distinct stored secrets and ownership; creation/policy/initialization failures; cleanup retry and missing-resource idempotence; replacement without deleting another owner's environment; concurrent same-owner start rejection; exactly ten successes out of eleven concurrent starts; bounded command options and persisted tool output; controlled capture cleanup; stderr/nonzero-exit/output truncation; abort mid-execution with lease release and successful continuation; injected service timeout; idle expiration preserving a fresh game. The prompt route's SSE stream emits a `billing` frame with exact cumulative spend and agent/monitor split after every recorded event, and the last frame equals `done`'s billing fields. Fakes reject unexpected requests and retain assertion failures even if application cleanup catches an error. No arbitrary shell interpretation occurs.

Containers were removed after both passing and failing runs. A SIGTERM check also verified exit status 143 and removal of the runner-owned container.

`npm run test:integration:coverage` writes a separate all-application-source report to `coverage/integration/`. Do not add its percentage to the offline percentage: combined coverage requires merging raw execution data. Deployment-only Linux/VM/network/provider behavior remains outside this suite. This command is not part of the pre-commit gate.

## Coverage decisions

Use `npm run test:coverage` for the current baseline. It uses [c8](https://github.com/bcoe/c8#checking-for-full-source-coverage-using---all) over the existing Node test runner: source maps recover TS/TSX locations and `all` includes never-imported source as zero. A raw native coverage trial reported 46.92% lines for loaded files and mismapped generated locations; it is not the application baseline.

The latest source-mapped all-source baseline is **22.18% lines/statements, 76.06% branches and 42.37% functions**. Scope is all runtime `app/**/*.ts`, `app/**/*.tsx` and `lib/**/*.ts`; only the type-only `lib/types.ts` is excluded. JSON summary is written to ignored `coverage/coverage-summary.json`. Tooling scripts are outside this application-coverage denominator. No numeric threshold is enforced yet.

`policy.ts` has 100% lines and 90.47% branches. `games.ts` has 16.50% lines, `runner.ts` 18.57%, `inference.ts` 55.25%, and `game-ui.tsx` 10.40%. All API routes, `http.ts` and server auth currently have 0%. High branch percentages are misleading here: uncalled functions and missing modules do not contribute a complete inventory of their branches. Import/initialization coverage is not proof of behavior.

Proposed policy once the first deterministic integration slice exists:

- Gate **combined unit + deterministic integration coverage**, not live smoke coverage: 85% lines and 80% branches for backend runtime code (`lib`, excluding browser-only `auth-client`, plus `app/api`). Keep UI coverage separately visible rather than inflating the backend score with JSX/imports.
- Critical owned validation/accounting modules: aim for 95% lines and 90% branches per module. More importantly, every named security/accounting invariant below must have a regression test, even if the percentage already passes.
- Require tests for changed behavior and review uncovered changed lines. Ratchet coverage upward; do not add broad ignore comments or test implementation trivia merely to clear a number. Thresholds above are proposed targets, not claims that today's suite passes.
- Do not demand 100% repository coverage or use coverage as a defense/security evaluation. Do not gate LLM behavior by deterministic coverage percentages.

## Proposed three test layers

### Pure unit tests on every commit

Keep `node:test`, assertions and `tsx`; no runner migration needed. Proposed command `test:unit`, target **under 2 seconds** (budget, not measured future runtime). No network, database, SDK sessions or credentials; unexpected outbound requests fail.

Move only dependency-free logic into a small pure module where needed, rather than mocking imported `db` or `runner`: admission arithmetic currently lives in `games`, and transcript repair in `runner`. Preserve public behavior/callers. Split the existing mixed tests accordingly; retain the SDK and SSR tests as offline integration tests.

Add table-driven edge cases for strict monitor schemas and reasons, flag matching, pricing precision/rounding/invalid input and 63/64-token admission boundaries, transcript repair/idempotence, reasoning transfer, diagnostic redaction and HTTP origin/body-size/JSON validation. Test contract outputs and rejected inputs, not internal helper calls.

### Deterministic integrations on every PR

Proposed command `test:integration`, target **under 30 seconds after database startup**. Use a disposable local Postgres database with the real schema/migrations, real `pg` SQL/transactions, real Better Auth, real Pi SDK and real Next route handlers. No production `.env.local` and no paid credentials. Local Postgres remains offline; an opt-in disposable Neon branch can provide hosted parity later.

Stub only out-of-process service boundaries:

- OpenRouter transport: catalog, completion and generation endpoints. Feed wire-format fixtures through the real inference adapter and Pi runtime. Assert outgoing model/tools/response format/reasoning, replayed context and billing metadata; return success, malformed replies, 429, missing usage, timeout and abort cases.
- Resend transport: capture the actual SDK request, verify email/link construction, then use the real auth token/cookie handlers. Do not mock the auth session or ownership result.
- Sprite service edge: now implemented as strict remote SDK-operation stubs, keeping real client/handle objects and app adapters. A per-environment map tracks policy/initialization/secret state; expected commands have fixed results, with injected create/execute/delete failures. It proves orchestration and nonexecution after rejection, not SDK wire compatibility or shell/network isolation. Keep real Sprite transport/contract checks and actual shell isolation in deployment smoke; do not build a general shell emulator.

Reuse/convert the assertions in `auth-check`, `budget-check` and controlled smoke rather than cloning them into another suite. Scope reconciliation/cleanup to a disposable database so real concurrency/foreign-key/transaction behavior remains exercised. Use one narrow injection seam only where the transport cannot already be intercepted; no fake database or parallel fake application.

Required integration invariants:

1. Cross-owner reads/prompts fail; wrong/missing origins, oversized/chunked/malformed bodies and invalid prompts/models fail before work or spending. Cron authorization denies unauthorized cleanup.
2. Concurrent starts respect capacity/per-owner/global limits; concurrent claims allow one lease; expired leases cannot spend. Assert at least one admitted request as well as upper bounds, so tests cannot pass when everything rejects.
3. Concurrent reservations cannot exceed guest/member/daily caps; settlement is idempotent, unknown usage retains holds, known unbilled failures refund, and reconciliation settles once. Exercise contention on real independent DB connections, with ample unrelated daily budget.
4. A prompt to a legacy run is refused with status 410 before a lease, event or inference request.
5. Switching attack models preserves environment/flag/history and drops incompatible reasoning signatures; capture derives from agent/reasoning/tool output, not guessed player text. Exhaustion, abort, failed initialization and retryable deletion leave recoverable persisted state.
6. Real magic-link flow transfers a guest run and upgrades budget once; replay is rejected; settled cheapest wins are monitor/difficulty-separated/private and mixed-strategy filters exclude mixed runs.
7. Run setup twice on a fresh database and on a representative legacy fixture: preserve transcripts/confirmed charges, backup uncertain historical billing, and prove reruns do not change balances. Never run this against shared data.

### Real service smoke and browser e2e before promotion

Seldom run means **per deployment candidate**, not per commit; also rerun after provider/SDK/auth/infrastructure changes. Proposed total budget **2–5 minutes**, to be measured. Use a dedicated deployment/test DB, disposable users, a real verified email inbox, capped inference allowance and tagged Sprites. Record commit/deployment/environment, elapsed time, spend and cleanup result; a failed or absent run prevents promotion.

Keep the suite small: guest session → create a private run → harmless command and visible reasoning/tool/SSE events → reload persistence; cross-owner denial and actual Sprite isolation/egress policy; one worker catch; verified magic-link delivery/sign-in/guest upgrade; stop/recovery and cleanup. A controlled approval in integration covers exact capture deterministically; it is not a genuine monitor bypass.

Use Coldtea `qa_*` for browser workflows against the deployed HTTP app (start with `qa_capabilities`), not another Playwright/Cypress framework. Combine backend smoke evidence with browser assertions of user-visible behavior. The existing live prompt expectations can vary with model responses: distinguish provider outages from regressions and save evidence, but do not silently retry failures into green results. No browser QA runs or recurring PR QA configuration were created in this pass.

Run `CTF_SMOKE_DISPOSABLE=1 npm run smoke -- --messages-only` only against a migrated, fresh disposable database and real test Sprites. The script checks that run, session, inference and job tables are empty before starting its cleanup and worker. Messages-only intercepts model completions, classifier, catalog and generation requests in process. The live smoke command uses real model services for its existing live scenarios. Both modes exercise asynchronous command progress, pending submission, worker review and real Sprite termination through controlled async completions.

## Avoiding excessive mocking

- Never mock SQL, reservations/settlement, leases, ownership/auth decisions, monitor parsing, transcript repair or the Pi state machine in integration tests. Those are what the tests must verify.
- Fakes must validate requests and implement only the service contract needed by a scenario. Unexpected URLs/commands/calls fail rather than falling through to the internet or returning generic success.
- Assert externally observable results: stored balances/events, exact executed commands, response status/cookies/stream frames and resource cleanup. Call counts alone are insufficient.
- Pair each fake service boundary with a small real-service deployment contract check. Sanitized live response fixtures must omit flags, credentials and transcripts; refresh them when provider versions/shapes change.
- Spot-check test strength by temporarily breaking an important invariant (allow an invalid monitor decision, skip an owner predicate, settle twice): its targeted regression must fail. Do this initially and when changing that path; no mutation-testing framework is needed yet.

## Remaining audit findings and next slice

- Current integration scripts are unsafe as unattended shared-environment PR checks: unscoped reconciliation/cleanup can affect unrelated records. Budget/auth scripts remove many fixtures. Smoke requires a fresh disposable database, retains ended games/inference/events and consumes global start quotas; email/auth rate-limit artifacts may remain. Messages-only still uses real Sprites.
- An exploratory frontend lint run found 12 diagnostics: two effect dependency warnings, three React compiler-oriented diagnostics (render-time clock/ref access and state in effect), two internal anchors and five accessibility diagnostics. They need review, not blanket auto-fixes. Core lint passes; no React/Next/a11y gate is claimed yet.
- `npm audit --omit=dev` reports one high-severity transitive `brace-expansion` advisory under Pi's coding-agent package. A fix is available; dependency/security remediation is separate from this formatting/test audit. No blind `npm audit fix` was applied.
- The shell initially used Node 25 despite the project's Node 24 engine. All reported validation/timing runs used installed Node 24.16.0; contributors and future CI should do likewise.
- Local hooks are bypassable and not a deployment policy. Mirror `npm run check` and build in PR checks, then add deterministic integrations and enforce the smoke-before-promotion requirement. No CI provider/workflow was added without choosing its deployment path.

Recommended next implementation slice: reuse the new disposable Postgres harness, move the existing real-SDK/SSR tests to offline integration, and migrate the accounting/auth checks. Add the critical ownership/body/monitor nonexecution regressions, measure runtime and combined coverage, then set the proposed gates and wire the small deployment suite. No broad application refactor or new test framework is needed.

## Direct HTTP flag submission checks

The direct-upload feature needs three separate kinds of proof. Use Node 24 and no shared `.env.local` credentials for the offline commands. `npm run check` and `npm run test:coverage` cover the pure protocol and React rendering regressions, including stored tool transport, HTTP help, generic pending receipts and terminal copy. `npm run test:integration` uses disposable Postgres and strict service boundaries to exercise capability admission, bounded request parsing, command completion before promotion, races, recovery and historical runs. Run `npm run build` for the production bundle. Coverage includes the new receiver and existing owned runtime source; it does not prove network isolation.

The submission route is `POST /v1/end/<token>` on the app's public HTTPS origin. The path token is the only credential, and no header or content type is required. Check deployed method, query, per-dispatch path-token authentication, the `401` for bare `/v1/end`, duplicate security headers as normalized by Web Headers, raw UTF-8 body, size and read-deadline behavior through the real route. It must use fixed no-store responses without body echo or correctness disclosure. The Sprite policy allows the exact configured app hostname and denies other domains. Read back the policy before first execution. Other app paths on the allowed hostname remain reachable; this check makes no exclusive-IP or URL-only isolation claim. A Vercel WAF rule limits `/v1/end` and every path under it to 30 requests per 60 seconds per IP. Prove its `429` against a deployed `/v1/end/<token>` before production promotion. Its counters are regional, not a global rate limit.

Use a bounded, no-database-write Sprite probe against the local tunnel. Outside the Sprite, prove an unrelated HTTPS control is reachable. Inside the Sprite, require explicit denial for that host while the allowed submission host returns `405` to GET. A timeout alone is inconclusive. Public unauthenticated POST must return `401`. Keep the full `scripts/flag-submission-smoke.ts` for a separate opt-in deployment contract against an empty, migrated `ctf_smoke_*` database. It uploads a synthetic file as the raw request body without printing its bytes or token. It tests response loss, exact idempotent replay, one durable receipt and cleanup. Route integration tests cover review and scorer ordering. Check that the uploading command and active sibling results are durable before finalization, and every session is reviewed.

For the authenticated local browser, run `npm run dev`, which starts an ngrok tunnel to the same local app and database and sets `SITE_URL` to its origin. Check start, reload, submission instructions, pending receipt, terminal result and historical earlier-protocol display on desktop and mobile. The current free ngrok account has only its 4,000 HTTP requests per minute account-wide cap. Its path-specific rate-limit action is unavailable, so no local per-path `429` proof is claimed. Keep these live checks opt-in with synthetic credentials, capped spend and scoped cleanup. See [the submission guide](../deploy/flag-submission.md).
