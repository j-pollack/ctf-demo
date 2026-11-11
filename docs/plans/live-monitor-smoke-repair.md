# Live monitor smoke repair

Checkout: `/Users/jonathan/Code/ctf/.worktrees/persistent-run-sessions`
Branch: `feature/persistent-run-sessions`
Baseline: `5632487`, clean at investigation start.

## Scope and evidence

The full live smoke failed twice at the sibling shared-file-read assertion. The first attempt logged a finish_review tool failure. The second returned a reason over the 400-character schema limit but emitted no equivalent runner error. The controlled-model smoke passed with real Sprites. The failing scenario uses the retained legacy runner. The diagnostic investigation below established the second failure mechanism.

Do not relax verdict, citation, schema, budget, ownership or execution-admission validation. Do not replace the real model test with a stub to declare it passing. Do not change async monitoring behavior without evidence that it shares the defect.

## Plan and ownership

- [x] Lead captures isolated live-run session/review/event diagnostics before cleanup, using `.env.local` service credentials and disposable Postgres.
- [x] Runner developer investigates smoke orchestration; independent reviewer investigates real Pi validation and event handling. Read-only until mechanism and repair are agreed.
- [x] Record cause and the narrow repair, then independently verify it before implementation.
- [x] Scoped developer adds failing real-component regressions and minimum fix. Lead reruns focused and repository gates plus live smoke.
- [x] Independent reviewer checks full repair and evidence. Local commit is authorized by the user's request to commit the work and subsequent instruction to proceed with the repair. Push and deployment are not authorized.

## Acceptance

- D1: Failed smoke preserves actionable review error and session/command state without credentials or unrelated-user data. Cleanup still runs.
- R1: Malformed finish_review arguments never count as valid coverage or allow a protected action. Real Pi orchestration proves this, not a mocked monitor.
- R2: The demonstrated live failure has a meaningful regression and a narrow correction. Correct review decisions and sibling commands preserve their existing order/admission rules.
- S1: Controlled real-Sprite smoke and full live-model smoke results are reported separately. No claim of full success on a partial run.

Check mapping: D1 isolated diagnostic run and failure artifact inspection; R1/R2 focused integration test through production orchestration with only external completion transport stubbed; S1 live smoke with disposable databases. Run npm run check, npm run test:coverage and npm run test:integration:coverage after code changes. Browser proof only if browser behavior changes.

## Diagnosis and approved repair

The diagnostic capture `.artifacts/live-smoke/diagnostic-1794374622718.json` preserves synthetic assistant errors from failed review callbacks, zero sibling turns and no sibling command. Local Pi Agent source confirms that rejected awaited subscribers are caught by its lifecycle wrapper, converted to synthetic assistant errors and followed by a normally resolved prompt. Both application runners failed to latch these subscriber errors. This could review the synthetic error instead of surfacing the original failure.

Malformed finish_review invocations are a separate recoverable input problem. The model has emitted overlong reasons, duplicate refs and nonmatching excerpts. The independent plan verifier approved the following repair:

1. Keep all existing tool schema and semantic validation bounds, including reason max400. Validate the entire decision before its latch. Return ordinary Pi tool feedback for invalid finish_review arguments and permit correction within the existing eight model calls, deadline, context and budget limits. No invalid decision becomes approval. Keep retrieval/provider failures and unexpected decision callback failures fatal. Give explicit prompt guidance for short reasons and unique exact citations.
2. Catch and latch failures at both runners' awaited persistence/review subscription boundaries. Abort and suppress follow-up persistence/review of SDK synthetic failure messages. Existing response-error handling surfaces the original failure. Preserve command cleanup and unknown-outcome handling.
3. Improve scoped smoke failure diagnostics before cleanup, including operational review errors and compact session state. Never print credentials or arbitrary transcript bodies. Keep cleanup intact.

Backend developer owns `lib/monitor-review.ts`, `lib/monitor-evidence.ts`, and investigator regression tests in `tests/integration/monitor-eval.test.ts`. Runner developer owns both runner implementations and subscriber regressions in `tests/integration/sprites.test.ts`. Coordinate if test seams require changes across ownership. Lead owns plan and isolated live diagnostic harness. No unrelated edits.

Additional regression criteria: invalid reason then valid correction; duplicate and mismatched citations then valid correction; repeated invalid calls exhaust the unchanged bound without approval/execution; retrieval/provider failure remains fatal during correction; valid finish stops later tool calls; legacy subscriber failure surfaces once without synthetic-error review; async persistence failure surfaces with safe command cleanup. Full existing command/submission scenarios must remain passing.

Candidate-review refinements before final verification: distinguish explicit application validation errors and SDK schema rejections from internal/tool callback faults. Only the former are correctable. After a response failure, still persist authoritative results for dispatched commands in both runners without initiating another legacy review. Suppress synthetic SDK assistant errors, not actual command outcomes.

D1 diagnostic checks passed: focused smoke-contract tests, lint, TypeScript and owned formatting. An isolated exercise of the actual smoke catch clause confirmed original-error identity and cleanup on both diagnostic success and failure. Output contains only scoped metadata and fixed error categories.

## Final verification

The real Pi/Postgres regressions reproduced rejected-subscriber synthetic-error handling in both runners, then passed after latching. A separate real tool-event delivery failure reproduced a stranded legacy review; closure now occurs before failure-prone emission or in its error path. The focused Sprite suite passes 159 tests. Investigator tests cover reason/schema rejection, duplicate and mismatched citations, correction exhaustion, retrieval/provider faults, and unexpected validator/callback faults.

Lead final offline checks and coverage pass 154 tests. Final integration coverage passes 179 tests, with all-source line coverage 62.59%, branch coverage 78.64% and function coverage 87.45%. Logs are `.artifacts/live-smoke/final-{check,offline-coverage,integration-coverage}.log`.

The first repaired live run correctly caught the writer after it completed the setup command and autonomously attempted a flag read. All three benign smoke setup prompts now specify one exact command and an immediate stop. No assertion or catch criterion changed. The final prompt-only change also passed all 154 checks in `.artifacts/live-smoke/scoped-check.log`.

Controlled inference with real Sprites passed the complete smoke suite in `.artifacts/live-smoke/messages-only-repaired.log`. This covered shared files, catch and remote termination, async progress, pending submission, reviewed capture and budget exhaustion. Sprite environments and the disposable Postgres database were removed.

The full live-model suite FAILED in `.artifacts/live-smoke/full-scoped.log`. It passed the original shared-file, sibling-read, catch and remote-deletion scenario, plus direct protected-read rejection. Later, the fork's benign read stopped because the investigator reached its output-token limit. The original error surfaced, no fork agent command continued, and the shared-file assertion failed because the read never ran. Sprite environments and the disposable Postgres database were removed. This remains a failed deployment gate. No further paid retries or limit increases are part of this repair.

Independent final review approved the repair with no P0–P2 code or security findings. The reviewer checked the full diff, real-component regression evidence, offline and integration gates, controlled live smoke and failed full live smoke. D1, R1 and R2 are satisfied. S1 is satisfied by reporting the two smoke outcomes separately, not by claiming the full live suite passed.
