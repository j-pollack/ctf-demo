# User-scoped transcript correlation

Worktree: `/Users/jonathan/Code/ctf/.worktrees/persistent-run-sessions`
Branch: `feature/persistent-run-sessions`
Baseline: `ab70e9a853b86a20263ac198e65f43ae7d889434`, clean index/tree. User explicitly requested reusing this existing feature worktree; primary checkout and user's port 3002 server stay unchanged.

Lead: inherited GPT-6 high reasoning. Independent plan verifier/reviewer: GPT-6.1 Sol high. Scoped implementation: GPT-6 Sol medium.

## Behavior contract

The monitor receives the current transcript and canonical owner user ID as its only explicit correlation key, never an API credential. Retrieval includes the same user's historical and concurrent sessions across runs, including unrelated environments. The investigator must infer relationships from transcript evidence. No run/Sprite/workspace grouping key, per-run ordinal or observation revision is supplied to the model. User-supplied transcript text is evidence and is not rewritten.

Retain raw run/session IDs and target observation revision internally for billing, command admission, stale-review fencing, finalization and teardown. No change to those security boundaries, auth, public session HTTP APIs, storage IDs or database schema.

Capture in repeatable-read using canonical target run owner. Require the full current session, then select additional whole sessions globally by recency, without prioritizing its run. Bound candidate metadata to a named maximum of 100 historical sessions and retain the existing 2 MiB serialized snapshot cap; include exact omitted-session count, distinct from retrievable pagination remaining. Fetch transcript bodies only after sizing candidates. Oversized mandatory target fails closed. Truncation is explicit evidence uncertainty, never an assertion of complete user history.

Each capture has a random opaque namespace. Session aliases within it are opaque and consistent across initial evidence, retrieval arguments, refs and cursors. Public metadata excludes raw source session IDs (first session ID equals run ID), ordinals, game IDs, revision counters and review IDs. Command state still exposes proposed/admitted/completed/interrupted/unknown and tool-call identity. Source reasoning visibility requires both the source run's policy and the current review's permission. System prompts remain unavailable. Inventory order is user-wide recency, not workspace order.

Prompt explains that same user and matching paths do not prove a shared filesystem or that an older action affects the current target. Retrieval is optional investigation under existing call/page/context limits. Preserve valid citations, frozen content and per-capture cursor rejection.

## Criteria and checks

- C1: Same-owner current/sibling/prior unrelated sessions are retrievable, another owner's decoy is not. Real Postgres integration with ended and active runs.
- C2: Serialized model-visible messages/tool payloads and decoded cursors contain no application-injected raw run/session IDs, ordinals, revisions or workspace namespaces. Unit projection checks and real outgoing model-message/tool-result inspection. Provider transport session_id telemetry is outside model-visible content and remains unchanged.
- C3: Initial and paged evidence share frozen aliases/refs; another capture's cursor and unknown aliases fail. Existing citation/retrieval tests plus new namespace checks.
- C4: Current full transcript retained; historical candidate/byte limits produce exact explicit omission counts; oversized current transcript rejects. Real Postgres capacity checks.
- C5: Source-hidden reasoning stays hidden under a permissive current review; current-hidden permission also restricts all source reasoning; system prompts never available. Unit and SQL integration.
- C6: Same-run sibling mutation still invalidates admission; a same-owner unrelated-run mutation does not invalidate target-run admission, and another owner's mutation cannot authorize/stop another run; existing finalization, billing, cancellation and catch tests stay passing. Existing real integration regressions.
- C7: Synthetic/live evaluator fixtures and descriptions represent owner-only correlation. Another-owner decoys remain inaccessible; same-owner unrelated histories are present. Offline evaluation and fixture tests. No live-model budget is authorized.

## Steps and ownership

- [x] Inspect snapshot, retrieval, projection, authorization and evaluation callers; independent architectural assessment.
- [x] Independent written contract approval with explicit same-owner unrelated-run stale-admission regression and model-visible payload scope.
- [x] Add meaningful failing regressions before implementation; same-owner historical inclusion fails against the old code in `.artifacts/correlation/same-owner-red.log`.
- [x] Implement snapshot scope and projection at current boundaries; update coupled tests/evaluation fixtures.
- [x] Run `npm run check`, `npm run test:coverage` and disposable `npm run test:integration:coverage`. Read actual output. No shared `.env.local` or paid services.
- [x] Independent full-diff review approved with no P0–P2 findings; no correction cycle required.

Core developer owns `lib/monitor-snapshot.ts`, `monitor-tools.ts`, `monitor-review.ts`, `monitor-orchestration.ts`, `monitor-evidence.ts`, `lib/types.ts`, monitor version and focused unit tests. Verification developer may own evaluation scripts/fixtures and integration tests with explicit coordination after plan approval. Lead owns plan and QA artifacts. No source edits outside this checkout. No new dependency, schema migration, UI redesign, production migration or user-history backfill. No commit/push/deploy unless requested for this follow-up.

## Implementation notes

The unused worktree was removed after the user explicitly requested continuing in the original feature worktree. All workers use the path/branch recorded above.

Core implementation owns monitor snapshot/projection/prompt and focused monitor unit tests. Fixture implementation owns integration/evaluation adapters and tests plus the rules explanation. No edits overlap. Initial same-owner integration regression failed its intended historical-inclusion assertion; existing behavior provided the red baseline. The suite reported 143 passing tests and the new failing subtest plus its parent.

## Verification evidence

- C1: Real Postgres tests include same-owner ended unrelated runs and exclude another owner. Candidate-count and byte limits retain the current target and report exact omissions. SQL sizes transcripts before loading and batches selected histories using existing game/session indexes.
- C2: Unit checks inspect initial evidence, paged results and decoded cursors for raw IDs/revisions/ordinals. Integration inspects actual model-visible messages/tools, including a real Pi `read_transcript` request and its replayed historical tool result. Provider routing/billing envelope remains separate.
- C3: Snapshot copies remain immutable. Raw session IDs are rejected as retrieval arguments. Cross-capture cursors reject. Existing citation validation, chunk pagination and retrieval limits remain passing.
- C4: Count limit is 100 historical candidates plus the required current session; byte limit is 2 MiB. Oversized historical sessions are omitted, oversized mandatory target fails. Tests cover exact omissions and target membership.
- C5: Real Postgres and pure tests confirm source-hidden reasoning stays hidden with permissive current settings and current-hidden settings restrict visible source reasoning. System prompts remain absent.
- C6: Same-owner unrelated-run mutation preserves target admission revision and admission succeeds. Same-run sibling mutation invalidates stale evidence. Existing catch, cancellation, finalization, fork restoration and accounting regressions pass; parent history is now present without reusing its execution approval.
- C7: Evaluation corpus distinguishes other-owner decoys from same-owner unrelated history. Live adapter seeds both ownership relationships using synthetic independent user identities. No live model evaluation was run.
- Lead `npm run check`: all lint/format/types checks and 143 tests passed. `npm run test:coverage`: 143 passed, 33.57% all-source line coverage.
- Lead `npm run test:integration:coverage`: 150 passed, 56.49% all-source line coverage. These are separate reports, not combined coverage.
- Browser inspected actual `http://localhost:3002/rules`: cross-run history, cross-user exclusion and inference of shared filesystem context are described correctly. QA browser closed; user's server preserved.
- Logs: `.artifacts/correlation/check.log`, `coverage.log`, `final-integration-coverage.log`, `model-tool-result.log`, `core-red.log`, `core-green.log`, `same-owner-red.log`. Early fixture failures are superseded by final green logs.
- No shared database mutation, paid service calls, migrations, commits or pushes performed for this follow-up. New unused checkout was removed at user's request; all changes remain in the existing worktree.

## Final review

Independent reviewer approved the full diff against `ab70e9a` after inspecting the final check, coverage, integration and Pi retrieval logs. No P0–P2 findings remain. The defensive exact-size historical trimming branch is not directly covered. Live-model detection quality and deployment verification remain untested by this change.
