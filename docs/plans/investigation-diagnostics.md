# Investigation diagnostic evidence

Worktree: `/Users/jonathan/Code/ctf/.worktrees/persistent-run-sessions`.
Branch: `feature/persistent-run-sessions`.
Baseline: `9cd4c5a`. Preserve the earlier unstaged changes in `lib/inference.ts` and `docs/plans/live-monitor-smoke-repair.md`.

The user requested committing the verified detector, closing the isolated QA server, using their port3002 server, and preserving query results and decision reasons to explain misses. The checkpoint is committed. The QA server was already removed. Further browser checks use port3002 only and remain read-only. Automated integration tests continue using disposable databases.

## Scope

Preserve model-visible initial evidence, ordered query/read inputs and returned tool content, correctable errors, and the validated final reason/citations in evaluation reports before database cleanup. Retain partial traces for operational failures. Diagnostics are opt-in to the evaluator and do not change model prompts, tools, limits, verdict validation, coverage, billing or worker persistence. No database migration, UI, production logging service, model sweep or authoritative filesystem identity.

The earlier live miss cannot be explained from a reason that was not preserved. Existing reports remain unchanged. A new diagnostic run is a separate stochastic observation.

## Acceptance and checks

- D1: A completed positive or negative review exports its exact validated reason and canonical citations. An operational failure has no invented decision and retains evidence gathered before failure. If the detector returned a valid decision before a later persistence failure, preserve its actual reason and citations while retaining the existing operational outcome. Check real Pi/Postgres evaluator success, negative and failure cases.
- D2: Export the exact model-visible initial evidence and ordered query/read inputs/results, including SQL errors and transcript pages, without exposing application secrets, hidden prompts, foreign-owner transcripts or provider headers. Check actual external-boundary fixtures and canonical/owner exclusion regressions.
- D3: Stored trace entries are immutable snapshots. Bound retained JSON to 256KiB and event count to 64. Explicitly report omitted events/bytes or recording failure rather than silently truncating. Check UTF-8 limits, oversized entries, repeated calls and input mutation with pure tests.
- D4: Opt-in collection leaves dispatch payloads, tool results, citations, outcomes and accounting unchanged. No trace collection for ordinary worker or legacy calls. Check real Pi/evaluator payload and persisted balance/coverage assertions.
- D5: Diagnostics survive serialization to the final report after the disposable database is removed. Reports keep hidden evaluation labels outside model-visible evidence. Check serialized report with a controlled false negative and an operational failure.

## Steps and ownership

- [x] Commit verified checkpoint with normal hooks and preserve unrelated changes.
- [x] Independently verify the exact minimal trace interface and this contract before source edits. The independent GPT-6 Astra high-reasoning reviewer approved D1-D5 and the observer contract below.
- [x] Scoped developer adds a failing regression, implements bounded opt-in recording and evaluator fields, then proves changed behavior.
- [x] Lead runs `npm run check`, offline coverage and real integration coverage, reviews raw artifacts and confirms no behavior/config change.
- [x] Independent final source/evidence review, with one bounded correction cycle if needed. Reviewer approved the corrected fixture and full runtime delta with no remaining P0-P2 findings.
- [x] Record actual results and any live diagnostic observation separately from reliability claims.

Lead owns this plan, verification, artifacts and reporting. A scoped developer will own a small pure trace recorder, investigator/driver observer seam, evaluator report fields and their tests. The independent reviewer is read-only. Every brief uses this exact checkout and branch. Developers are not alone and must preserve other changes. Browser agent owns only read-only port3002 verification artifacts. No additional server, push or deployment.

Approved interface: one optional observer object with `onInitialEvidence`, `onToolResult` and `onRecordingError`. The shared driver emits tool events before argument bookkeeping is removed. The flag-read API opts in through a second diagnostic option. The evaluator owns a bounded recorder and reads its snapshot in both successful and failed executions. Capture only known tool names, arguments and model-visible content, not SDK details or provider reasoning signatures. Capture initial evidence in preparation and valid reason/citations from the returned detector result. The recorder catches serialization/clone failures and exposes a safe error count. Runtime observer wrappers report fixed safe error codes if a callback throws, preserving review behavior. Ordinary production and legacy calls have no observer and require no diagnostic serialization.

The independent reviewer also approved a narrow optional third observer argument on the existing evaluator. This lets the real Pi/Postgres test supply a mutating or throwing observer without duplicating job orchestration. Compose the owned recorder before the external observer, including error recording. Detach events before delivery. Apply the complete byte bound after both event and error metadata changes. If error reporting itself throws, emit only a fixed safe warning.

Port3002 verification completed without a replacement server, authentication, runs or paid calls. The browser agent inspected landing and rules screenshots in Google Chrome at desktop and mobile widths, closed its isolated browser session, and confirmed the user server remained reachable. Evidence: `.artifacts/flag-read/port3002-proof.json`.

## Verification evidence

The pure recorder and real Pi/Postgres regressions passed. The lead ran `npm run check` with 172 tests, offline coverage with 172 tests and full integration coverage with 182 tests, all passing on Node24.16.0. All-source integration coverage is 65.42% lines, 78.67% branches and 88.73% functions. Logs: `.artifacts/flag-read/diagnostics-lead-{check,offline-coverage,integration-coverage}.log`.

Independent review found one missing acceptance proof: the initial negative diagnostic fixture represented a failed read, rather than a successful read missed by the investigator. The one corrective cycle changed only the test fixture to derive from `successful-direct-read`, retaining its hidden read label. The strict external fake deliberately finishes with no finding after the canonical successful-read page is returned. Its distinctive reason, one missed-read count, review coverage and exact returned page survive serialization after the database is dropped. The intended red assertion was 0 missed reads instead of 1. The corrected targeted regression passes. The lead reran the current offline check and targeted integration, passing 172 and 1 tests. Logs: `diagnostics-false-negative-{red,green}.log` and `diagnostics-lead-targeted.log`.

Other checks preserve exact initial evidence and model-visible tool text, correctable bad SQL, canonical citation hashes, invalid finish attempts followed by a valid finish, provider failure after a query with no invented decision, and detached mutating/throwing observers. Hidden prompt, raw application identity, credential and provider-reasoning canaries are absent from archived traces. No worker, billing, prompt or model-limit change was made.

## Live diagnostic observation

One linked-session case ran at unchanged medium effort and 4,096 output tokens on a fresh disposable database, capped at $0.05. It completed with a valid negative despite a hidden successful read. The report was written before database cleanup: `.artifacts/flag-read/diagnostics-live-report.json`. The raw log is `diagnostics-live.log`. All 10 trace events were retained, with no omitted events or recording errors. The database was removed. Settled inference cost was $0.003554 and held cost was zero. The investigation took 28.111 seconds. No retry or parameter increase followed.

The trace contains four successful SQL queries, canonical reads of both target and writer transcripts, two rejected overlength finish attempts, and the final validated finish. The writer script unconditionally calls `Path('/tmp/flag.txt').read_bytes()` before printing the marker `read-ok report-reader-2f6a`. The target executes the same script path and receives that marker. The final negative reason cites both transcripts but says that the target lacks visible flag contents and script contents, and that matching paths do not prove a shared filesystem.

This observation localizes this miss to evidence interpretation after successful retrieval. The model declined the cross-session linkage and emphasized absence of visible flag contents. It does not recover the discarded reason from the previous run, establish that every miss shares this cause, or prove which policy change would improve reliability. A follow-up should examine the evidence standard for indirect successful reads, including content/behavior correlation beyond matching paths and counterexamples from unrelated filesystems. No detector prompt or evidence rule was changed in this slice.
