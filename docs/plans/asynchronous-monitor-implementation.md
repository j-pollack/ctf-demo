# Asynchronous monitor implementation

Worktree: `/Users/jonathan/Code/ctf/.worktrees/persistent-run-sessions`
Branch: `feature/persistent-run-sessions`
Baseline: `ab70e9a` plus uncommitted, verified owner-correlation changes. Baseline diff/status saved in `.artifacts/async-monitor/`. Primary checkout and user's port 3002 server remain unchanged. User authorized reusing this worktree and implementation, not commit/push/deploy.

Lead: inherited high-capability model, high reasoning. Independent verifier/reviewer: GPT-6.1 Sol high. Scoped developers: GPT-6 Sol medium. Apply dev-factory, Ponytail, migration and Neon Postgres practices with disposable local Postgres and synthetic credentials.

## Contract

Commands execute after normal authorization and durable evidence persistence, without waiting for a model. Monitoring jobs survive agent/browser lifetime. Submit immediately closes play and returns a pending result. Correct flag and scoring produce confirmed capture only after all required review evidence resolves. Later detection overrides provisional success. Unknown/error/budget shortage never confirms capture. Current spend limits remain unchanged; exhausted monitoring funds explicitly leave unresolved results. No new paid allowance is authorized.

Same-owner literal transcript search reaches beyond the recent100-session cap. No workspace/run grouping key is exposed to the investigator. Search preserves hidden-system/source-reasoning restrictions before matching/counting/ranking. Matching paths are leads, not proof of shared filesystem identity. No persistent inferred filesystem graph or new search service.

## Evidence and coverage

Persist immutable observations alongside transcript writes. Per-session transcript version increments, and an epoch changes when a write is not a strict prefix-preserving append. Store changed message indices per version plus observation message count; retained observations reconstruct removed/replaced messages. Session serialization prevents lost updates. Initial sessions, forks and existing rows receive evidence through idempotent migration/backfill or their creation transaction. Legacy timestamp provenance is labeled as migration observation, never historical execution time.

Jobs coalesce only within an append-only epoch. An older repaired epoch remains a separate obligation. A job claim fixes its epoch/target version. Success cannot cover a newer requested version or another epoch. A review of a later append within the epoch includes the full earlier prefix. Oversized required evidence is unresolved rather than discarded. Do not silently erase obligations through repair, cancellation, budget exhaustion or cleanup.

Capture a short repeatable-read manifest of eligible owner sessions and committed versions. The target version is fixed to its job. Search/read use immutable versions bounded by this manifest. An allocated global ID/timestamp alone is not a valid commit boundary. Freeze source visibility policy and AND with current review permission. No long transaction during model inference.

Search exact case-sensitive literal substring initially, with bounded nonempty query and result/page/call limits. Search full visible text before chunking. Percent/underscore/quotes/Unicode are literal. Return opaque session/version references, match excerpts, server observation time and surrounding transcript access. Source current ownership is enforced at every retrieval. Cursors bind query, capture and scope. Legacy mutable paths remain separate from new immutable evidence until migrated.

## Compatibility and rollback

Persist games.monitor_mode as legacy or async. Database default stays legacy so older inserts cannot mislabel their behavior; production startGame explicitly inserts async and clients cannot choose the mode. Existing runs retain legacy execution. A new fork is async and its initial inherited transcript gets its own complete review obligation; parent disposition is never transferred as approval. New immutable evidence persistence also covers legacy writes.

Keep the existing legacy runner and add a focused async runner selected only by persisted mode. This avoids changing an in-flight legacy execution protocol. Shared auth, billing, cancellation and Sprite checks remain authoritative. Existing compatibility tests explicitly seed legacy mode; new tests must exercise ordinary production creation and HTTP paths with no mode override.

Migration expands schema idempotently and backfills evidence without changing existing transcripts/charges. Production rollout must drain/route old binaries away from async rows. Rollback requires stopping new async creation and draining or explicitly leaving async runs unresolved while retaining a compatible worker; old binaries cannot resume async runs. No schema contraction or automatic rollback/deployment is part of this change.

## Runtime

Postgres-backed review jobs own expiring fenced claims. Monitor reservations, dispatch and completion validate claim rather than live agent lease. Expired workers cannot spend or decide. Already-incurred provider cost still settles/reconciles; retries must not fabricate exactly-once remote execution. Bounded retry policy ends in visible unresolved, with no unbounded paid retries.

Separate command dispatch/outcome ledger from investigator decisions. Dispatch checks session lease, active run and execution generation immediately before remote execution. Preserve late outputs from already-dispatched commands after submission/catch as evidence, without permitting new execution. Unknown remote outcomes block successful finalization unless resolved by reliable termination/quiescence evidence.

Persist catch transactionally, fence generation and stop runners across processes through the existing one-second heartbeat with bounded database check. Pending monitor jobs never exempt attackers from revocation. Local abort is not proof of remote termination. Sprite teardown must respect all related runs sharing that Sprite and serialize with fork creation; never destroy an active child's environment because of delayed parent review.

Backend owns a persisted Sprite-wide operation exclusion/quiescence rule. Fork restore and scoring require known quiescence across every run sharing the Sprite. Deletion can establish quiescence by terminating eligible outstanding work. Reserve lifecycle work under the same serialized Sprite identity before external dispatch. A caught/expired finalizer's already-dispatched scoring command remains outstanding until its outcome/termination is known. Unknown remote outcomes prevent restore/scoring eligibility; lease expiry alone is not proof that the remote command stopped. A8 explicitly tests catch during in-flight attacker/scoring work followed by attempted fork, with no restore/scoring overlap or child corruption. Destructive teardown reserves the Sprite under the same lock, protects all related runs still needing compute including pending/unresolved submissions awaiting scoring and fork-retention, and may terminate eligible source-run work. Uncertain deletion retains the exclusion until reconciled; confirmed deletion marks operations interrupted, never successfully completed or review-cleared. Test unknown-command eligible teardown and refusal to delete a pending child environment. Sprite identity stays internal.

Submission persists correctness and finalization job, fences new work and returns. Background finalization waits for writers/commands to settle, seals review boundaries, verifies complete resolved coverage, runs existing bug checks sequentially on the quiescent Sprite, then rechecks state/coverage under the run lock before confirmed capture. No fixed HTTP review drain. Cleanup preserves jobs/evidence, and cannot turn pending review into successful credit. Only captured runs enter leaderboard.

Use a standalone worker command with signal-aware shutdown and recoverable jobs. No fire-and-forget HTTP dependency. Document production worker requirement; no provisioning/deployment in this change. Local QA starts worker against disposable test database only.

## Player state

Existing authenticated run polling returns monitor progress independent of prompt SSE: queued/reviewing/caught-up/unresolved/caught, pending session/update counts, processed count, last processed time and safe error explanation. UI distinguishes no observations from zero risk. Risk traces retain maximum processed session scores. finalizing means play ended with result pending; unresolved remains visibly unconfirmed. Reload and out-of-order responses cannot restore ended/caught play. An async submitted run must not prevent starting a new run under the existing quotas; starting another run preserves prior pending review/scoring resources and obligations. Legacy finalization restrictions remain unchanged. Retained pending Sprites count toward the global capacity limit, including same-owner resources; count shared fork Sprites once. Test available-capacity admission and full-capacity rejection without losing earlier debt.

## Acceptance and proof

Carry A1–A6, S1–S3, E1–E4 and U1 from `asynchronous-monitor-investigation.md`. Add explicit A7 cross-process catch/cancellation and A8 delayed-parent catch/fork teardown races. Tests use real SQL/transactions/auth/Pi and stub only external transport. No fake DB or orchestration mocks.

- M1: migration twice preserves old transcript/charges/identity, supports old active runs, new default behavior, and non-destructive rollback procedure.
- S1–S3: old beyond100 evidence, owner/hidden text exclusion, literal punctuation/chunk boundaries, concurrent writes and exact-version reads/cursors.
- A1–A3: delayed monitor while commands complete, durable restart/disconnect, stale claims denied, later update remains pending, nonappend repair retains old obligation.
- A4–A6: immediate pending submit, quiescent scoring and coverage, late catch, races, unknown/error/budget/size limits unresolved, correct billing.
- A7–A8: separate runner/worker process revocation and related-Sprite teardown eligibility.
- E1–E4: paired corpus cases for same-path different worlds, distinctive artifact link, ordered/ambiguous overwrites, unrelated prior wrongdoing. Controlled transport proves available evidence; no live-model quality claim without live evaluation.
- U1: browser visible lag while commands progress, pending-to-caught/captured, reload persistence and aggregate graph.

Required gates: meaningful red regressions before implementation; focused green; `npm run check`, `npm run test:coverage`, `npm run test:integration:coverage`; browser on isolated environment; independent full-diff review. Record raw logs. Live model quality and actual remote cancellation remain deployment gates unless explicitly exercised with authorized services.

## Checklist

- [x] Investigate and receive user approval, including submit ends play.
- [x] Record baseline, boundaries and evidence invariants.
- [x] Independent implementation-contract approval, conditional Sprite-wide quiescence correction incorporated; shared interfaces recorded below.
- [x] Evidence/search schema and focused regressions.
- [x] Worker/execution/submission/billing and regressions.
- [x] Progress UI and evaluation corpus initial focused checks.
- [x] Always-visible reasoning refinement and historical fork privacy regression.
- [x] Lead checks and browser verification.
- [ ] Independent full review and bounded correction if needed.

## Ownership and shared interfaces

- Evidence developer owns migration015 evidence schema, `lib/transcript-evidence*.ts`, snapshot/search/tools/evidence prompt, evidence-only unit/integration tests and evaluation corpus. It exports `persistTranscriptEvidence(client, {gameId,sessionId,runRevision,messages}) -> {version,epoch,changed,appendOnly}`, exact observation reconstruction and capture/search backed by a per-session committed manifest. Backend owns persistence call sites and calls this helper under session lock. No shared-file edits without coordination.
- Backend developer owns migration014 mode/jobs/commands/result schema, jobs/worker/async runner modules, games/sessions/lifecycle/classifier/inference hooks, worker CLI and setup/package wiring, backend integration tests and compatibility fixture migration. Job key is session+epoch, never session alone. Backend owns public types additions and monitor-review authorization plumbing; evidence developer coordinates its snapshot type changes directly.
- UI developer owns app progress rendering/polling and UI tests once public shape is fixed. It reads relevant local Next guides before edits.
- Lead owns contract, baseline artifacts, cross-component verification and browser QA. Reviewer is read-only. Developers are not alone and must preserve prior correlation changes.

MonitorProgress: status queued/reviewing/caught-up/unresolved/caught; pendingSessions, reviewedUpdates, totalUpdates, lastReviewedAt nullable ISO timestamp, optional safe reason. Expose as optional `monitor` on PublicGame for legacy compatibility and expose persisted monitorMode when needed to avoid falsely promising async on old runs.

Evidence/search limits remain explicit and non-successful on exceeded target context. Bounded transient retry default: three attempts with backoff; unknown/size exhaustion remain unresolved. Worker command is `npm run monitor:worker`, supporting one-shot use for deterministic deployment/QA contracts. No HTTP public worker trigger or new external dependency.

Plan review: independent reviewer approved after adding the required Sprite-wide quiescence/exclusion invariant and A8 race proof. No further plan blockers reported.

Evidence representation refinement: immutable suffix deltas replace separate message-version rows. Each observation stores changed_start, changed_messages, message_count and epoch, retaining replaced/truncated versions. Validate a complete contiguous version chain and bound reconstruction bytes/work before loading. The independent reviewer accepted this simpler equivalent with explicit limit failure.

Independent design refinement approved: deletion may terminate eligible outstanding commands instead of requiring them already quiescent. Related pending scoring runs remain protected. This distinction avoids making unknown remote work impossible to terminate.

## Reasoning visibility refinement

User requested removal of the reasoning visibility setting. All newly created async runs and forks use visible agent reasoning, enforced server-side. Remove the control and choice-related help text. Preserve historical source visibility metadata. When a hidden legacy transcript is inherited by a new visible fork, sanitize inherited hidden reasoning from the child copy while retaining the original parent's history. New child reasoning is visible. Independent review approved this direction subject to a regression proving both current-target and search behavior across that transition.

## Verification progress

Focused evidence SQL and immutable-history checks pass in `.artifacts/async-monitor/evidence-integration-green.log`. Evaluation corpus checks and the real SQL/Pi evaluator pass in `corpus-green-attempt.log` and `eval-integration-green.log`. UI focused checks pass in `ui-focused-green.log` before the reasoning refinement. Async command and immediate submission tests pass in `runner-integration-5.log`. Its cross-process worker test observed parent cancellation in about one second with an unknown command outcome and no subsequent dispatch. That log still contains unrelated unfinished backend cases and is not a full green gate.

Full offline and integration gates, frozen-source browser verification, and final independent code review remain pending. No live-model quality or remote Linux termination proof is claimed.

## Lead verification

- `npm run check`: passed, 150 tests. Raw output: `.artifacts/async-monitor/lead-check-final.log`.
- `npm run test:coverage`: passed, 150 tests. All-source line coverage 29.39%, branches 84.68%. Raw output: `lead-offline-coverage-final.log`.
- `npm run test:integration:coverage`: passed, 167 tests. All-source line coverage 62.56%, branches 78.07%. Raw output: `lead-integration-coverage-final.log`. Coverage reports are separate, not additive.
- Focused regression logs include `backend-focused-3.log`, `public-reason-red.log`, `public-reason-green.log`, `ui-advisory-red.log`, `ui-advisory-green.log`, and `evidence-integration-green.log`.
- Browser uses actual Next routes, Better Auth, Pi and disposable Postgres, with strict fake external services. Evidence in `.artifacts/qa-async-monitor/`: `01-held-write.txt` and `02-sibling-read.txt` prove shared filesystem activity while review remains queued. `05-capture-pending.txt` then `06-capture-result.txt` prove submission ends play and later confirms after review/scoring. `07-catch-pending.txt` then `08-caught-result.txt` prove delayed detection overrides a pending submission. `09-caught-reload.txt` and `10-capture-reload.txt` prove persistent terminal states. Final capture has no false investigation-error cards. Current strict-boundary violations log is empty.
- Earlier browser fixture rejected raw-UUID versus opaque-alias mismatch. Failure logs are preserved under `pre-alias-fix` names and are not capture proof. The failure did prove the application left the submission unresolved. Fixed harness validates the expected opaque alias and exact tool contract.
- Browser worker shares fake service state in one process. Cross-process revocation is separately proved by A7 in the integration suite. Live model quality, Linux execution, remote termination and production worker deployment remain unrun deployment checks.

Independent final review is pending. No commit, shared database migration, push or deployment has been performed.

## Independent review and corrective cycle

Final review requested changes despite green suites. The single automatic corrective cycle is now in progress:

1. Preserve a resumed session's newer transcript when an expired runner reports a late command result. Retain late evidence atomically.
2. Classify command outcomes using structured success/error state, never words in successful stdout.
3. Surface unknown-before-submission and orphaned command outcomes as unresolved after review catches up. Never grant credit.
4. Make literal tool-argument search match the exact canonical text displayed as monitor evidence, including JSON punctuation.
5. Adapt the opt-in smoke harness to async jobs and keep messages-only inference interception in the same process as the worker.
6. Add the promised destructive teardown regression: unknown-command eligibility, uncertain deletion exclusion/reconciliation, and pending-child protection.

Backend owns 1, 3, 6. Runner developer owns 2 and 5. Evidence developer owns 4. No live services are authorized by this corrective pass. Lead will rerun affected gates and request independent full-feature re-review. If any P0-P2 remains or appears then, stop automatic edits and report the decision needed, per dev-factory.

## Corrective verification

All six corrective items are implemented. Late command results merge into the locked current transcript and replace a repaired placeholder without erasing newer messages. Unknown and orphaned execution status derives from the command ledger, while healthy live commands can settle. Command uncertainty is separate from persistent scoring errors.

For literal parity, migration015 adds aligned public/with-reasoning canonical text arrays to each observation. Runtime normalizes the suffix through PostgreSQL before calling the shared visible renderer and inserting atomically. The idempotent bounded setup backfill fills only missing derived arrays. Source payloads and timestamps stay unchanged. Search refuses incomplete materialization and matches stored canonical text inside one repeatable-read capture with ownership/visibility filtering. The independent reviewer approved this refinement before implementation.

Smoke now requires explicit `CTF_SMOKE_DISPOSABLE=1` and empty application tables before cleanup or worker activity. Existing legacy contract scenarios remain explicit. New controlled async scenarios run the worker in the same process as model interception. Messages-only rejects unexpected inference calls. Live Sprite smoke was not run.

Lead corrective gates:

- `lead-corrective-check.log`: `npm run check` passed, 150 tests.
- `lead-corrective-offline-coverage.log`: 150 passed.
- `lead-corrective-integration-coverage.log`: 174 passed. All-source line coverage 62.75%, branch coverage 78.27%.
- Focused RED/GREEN: `backend-final-review-red.log`, `backend-corrective-reconcile.log`, `runner-f2-green.log`, `evidence-json-parity-red.log`, `evidence-json-parity-green.log`, and `backend-a8-teardown.log`. The full lead gate supersedes worker suites that preceded final refinements.
- Fresh browser replay against corrected source: `11-corrective-pending.txt` shows immediate ended play/pending review, then `12-corrective-capture.txt` shows confirmed capture with an unused sibling session. No erroneous investigation cards or strict service-boundary violations occurred. Earlier browser delayed-catch and reload proofs remain applicable; correction regressions separately cover uncertainty and stale writers.

The single automatic corrective cycle is complete. Independent full-feature re-review is pending. No commits or live/shared database migrations occurred.

## User-authorized second repair cycle

User approved a second repair cycle on November 10. Work remains in `/Users/jonathan/Code/ctf/.worktrees/persistent-run-sessions`, branch `feature/persistent-run-sessions`. The previous re-review found two P2 issues; its pending-review sentence above is superseded.

- [ ] R1: backend developer fixes semantic prefix comparison and fallback command-result ordering. Regressions must inspect every committed immutable observation, including stale completions and repaired placeholders, without losing newer history.
- [ ] R2: UI developer keeps exhausted/ended runs polling while review is queued or running. Regressions cover pending-to-caught and pending-to-unresolved, plus settled polling termination. Browser verification exercises terminal review debt. Include a selected historical run and mixed unresolved plus queued/reviewing sessions. Aggregate unresolved status alone does not stop polling while runnable review work remains. The independent plan verifier approved R1 and this clarified R2 scope.
- [ ] Lead reruns check, offline coverage, integration coverage and browser proof, then requests independent full-feature re-review.

Existing behavior contract remains unchanged. No unrelated cleanup, commits, live services, shared database migrations, push or deployment is included.

### Second-cycle verification

R1 uses semantic message equality and preserves the assistant's tool-call order when merging a late result into newer history. `r1-order-red.log` reproduces the committed result inversion. `r1-final.log` passes 15 focused tests, including every-version assertions for normal sequential results, stale completions and repaired placeholders.

R2 adds `monitor.hasPendingReview` from queued/reviewing jobs, so mixed unresolved and pending work keeps polling. Current and selected historical runs poll through delayed review. Historical refreshes fence owner, route, request, session and revision changes. Both intervals respond to review activity changes. `ui-r2-red.log` reproduces the stopped terminal poll; `ui-r2-green.log` passes focused UI regressions.

Lead gates on the second-cycle source:

- `lead-second-check.log`: 152 passed, including lint, formatting and TypeScript.
- `lead-second-offline-coverage.log`: 152 passed.
- `lead-second-integration-coverage.log`: 176 passed. All-source line coverage 62.33%, branch coverage 78.29%, function coverage 87.4%.
- `git diff --check` passed.

Browser terminal-debt proof and final reviewer acceptance remain pending. No commits or live-service checks performed.

### Second-cycle browser evidence

The isolated browser harness used real Next routes, Better Auth, Pi, Postgres and worker orchestration, with strict synthetic external service boundaries. Evidence is under `.artifacts/qa-r2/`.

- `older-ended-queued.snapshot.txt` and `older-ended-caught.snapshot.txt`: starting a new run ended the prior run through production orchestration. Its history detail changed from queued to caught without reload. Target requests stopped after settlement.
- `older-ended-queued-unknown.snapshot.txt` and `older-ended-unresolved.snapshot.txt`: an ended historical run received an unresolved verdict without reload. Target GET count stayed at 13 across 7.3 seconds after settlement.
- `live-ended-queued.snapshot.txt` and `live-ended-unresolved.snapshot.txt`: an authenticated new-run request ended the cached current run without changing the page. The live polling effect learned the ended state, continued through queued review, then showed unresolved without reload. Target GET count stayed at 18 across 7.3 seconds after settlement, exceeding two polling periods.
- `database-status.csv` corroborates terminal and review states. `violations.jsonl` is empty. Screenshots accompany the terminal snapshots.

Lead inspected raw test logs, browser snapshots and screenshot evidence. Both repairs and verification are complete; final independent acceptance and QA cleanup are being recorded below. Live Sprite/model smoke remains unrun. Changes remain uncommitted.

### Final second-cycle review

Independent full-feature review approved the second cycle with no remaining or new P0-P2 findings. The reviewer read final source, focused all-version regressions, lead gate logs and `.artifacts/qa-r2/proof.json`, raw resource timing, snapshots and database evidence. A1-A8, S1-S3, E1-E4, U1 and M1 have deterministic verification evidence. The reviewer independently confirmed that requests stopped after the live run became unresolved.

- [x] R1: immutable command-result ordering repaired and verified.
- [x] R2: current/history terminal review polling repaired, including mixed unresolved/pending work and stale response fencing.
- [x] Required automated gates, browser proof and independent full-feature review passed.

No commit is included in this repair authorization. Live model quality, real Sprite/Linux termination and production continuous-worker deployment remain unrun deployment gates.

QA cleanup confirmed: named browser closed before server SIGINT, disposable container removed, and user development server on port 3002 still responds HTTP 200.

## Authorized live smoke and commit verification

The user subsequently authorized committing the work and running local smoke with `.env.local`. Live service credentials were loaded from that file. Each attempt used a fresh disposable loopback Postgres database through the existing pool injection seam, avoiding cleanup or migration of the configured shared database.

- `.artifacts/live-smoke/messages-only.log`: PASS, exit 0. Controlled model completions with real Sprites verified isolation, shared-session file access, sibling catch, remote deletion, no multi-session rewind, async command progress, pending submission, reviewed capture, catch, remote process termination and budget exhaustion. Smoke Sprites and disposable Postgres were removed.
- `.artifacts/live-smoke/full.log`: FAIL. Live isolation/ownership passed, then an investigator `finish_review` tool failure prevented the sibling's shared-file read from completing. The assertion at `scripts/smoke.ts:304` failed.
- `.artifacts/live-smoke/full-retry.log`: FAIL on the same sibling transcript assertion during one bounded diagnostic retry. Recorded model tool calls include a 419-character finish-review reason, exceeding the schema's 400-character limit. The retry did not emit the same generic tool error, so that contract violation is evidence of invalid model output, not a proven complete diagnosis of the repeated failure.
- Both failed attempts cleaned up their smoke Sprites and disposable databases. No schema limits or test expectations were weakened. No production source changes were made during these smoke attempts.

The earlier deterministic review approval remains applicable, but the full live-model smoke is a failed deployment gate. Production worker deployment and broader model reliability are not verified. The precommit security/diff audit found no credential exposure, ownership/authentication bypass or SQL/input-validation blockers in the intended changes.
