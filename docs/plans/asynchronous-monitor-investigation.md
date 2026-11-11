# Asynchronous monitoring and transcript search investigation

Worktree: `/Users/jonathan/Code/ctf/.worktrees/persistent-run-sessions`
Branch: `feature/persistent-run-sessions`
Baseline: `ab70e9a853b86a20263ac198e65f43ae7d889434` plus the verified, uncommitted user-transcript-correlation changes listed in that feature plan. User authorized continued work in this checkout. Preserve the primary checkout and dev server on port 3002.

Status: source investigation complete; proposed implementation, not implemented or performance-validated. No live inference, database mutation, commit or deployment performed. Independent source investigations covered retrieval and execution lifecycle.

## User contract

Commands run without waiting for classifier or investigator inference. Transcript changes enqueue monitoring work. The player sees risk for processed evidence and explicit review progress. A later investigator detection catches the run and stops all remaining agents.

User confirmed: submission ends play immediately and leaves the result pending for asynchronous review. There is no continue-after-submission flow and no new Finish run action. A correct flag is provisional until required monitoring completes. Catch takes precedence over provisional success.

Monitoring correlates by canonical owner only. It can search that owner's history by arbitrary literal content, including filenames. Internal run IDs still bind execution, review obligations, accounting and catch attribution. They are not provided as filesystem grouping keys to the investigator.

## Findings in current source

- `lib/runner-session.ts`: message persistence awaits transcript investigations; command admission additionally awaits investigation; Sprite dispatch requires an allow permit. Submission stops agents, waits up to 20 seconds for drain, then performs a synchronous final investigation and scoring.
- `lib/sessions.ts` and `lib/run-lifecycle.ts`: transcript writes and review triggers already share transactions, but mutable message arrays replace prior transcript contents. Queued reviews require the originating live agent lease.
- `lib/monitor-orchestration.ts`, `lib/inference.ts`, `lib/games.ts`: monitor deadlines, dispatch and billing depend on agent authorization. Background jobs cannot safely reuse expired agent leases.
- `lib/run-lifecycle.ts`: catch currently requires a live source lease and an active/finalizing run. Cleanup and terminal transitions can currently make a later catch impossible.
- `lib/monitor-snapshot.ts`: frozen capture only includes up to 100 historical candidates, bounded by 2 MiB. The database transaction ends before investigation.
- `lib/monitor-tools.ts`: list/read tools only expose captured sessions. No content search, temporal evidence labels or persistent state reconstruction exists.
- `app/api/games/[id]/prompt/route.ts`: prompt work is tied to a cancellable request with a response deadline. `vercel.json` configures daily cleanup only. No independent review worker exists.

## Proposed implementation

### Immutable evidence and literal search

Preserve monitor evidence at transcript persistence boundaries, atomically with its review obligation. Prefer append-preserved messages with explicit correction/version handling over copying every growing transcript on every change. Before implementation, enumerate transcript repair/fork/model-switch mutations and choose the smallest representation that preserves them. Do not treat mutable JSON arrays as append-only without proof.

Capture an immutable evidence boundary for each review. The boundary must describe committed visible versions, not merely a timestamp or an allocated sequence maximum: concurrent transactions can commit out of allocation order. New evidence is assigned to a later review. Avoid a transaction/connection held open throughout LLM inference.

Add `search_transcripts({query, cursor?})`. The review supplies the canonical owner; the model cannot override it. Start with bounded, case-sensitive literal substring semantics. Percent signs, underscores, quotes, slashes and Unicode are literal, with no regex, wildcard language or embeddings. Search full visible message text before output chunking.

Search reaches eligible historical evidence beyond the initial recent-session cap. Apply owner and visibility filters before matching, ranking, counts and pagination. Hidden reasoning and system prompts must not influence whether a hit appears. Preserve source/current reasoning permission conjunction. Return short matching excerpts, opaque session aliases, citation refs and bounded surrounding-context retrieval. Match absence is not proof of filesystem absence.

Include server observation timestamps and within-session ordering where available, clearly distinguished from dates asserted inside transcript text. Do not invent timestamps for legacy evidence. Observation order is not proof of physical execution order across concurrent commands. Search evidence remains untrusted.

Historical evidence can support a verdict about the current review target. Misconduct in an unrelated earlier run alone must not catch the current run. Runtime catch remains bound to the job's source run.

### Investigator procedure to evaluate

Start with the new activity and its visible session context. Identify file paths, script names, distinctive strings and relevant tool outputs. Search these clues across eligible owner history, then read surrounding evidence for promising matches. Seek evidence of contents, writes, execution and later replacement rather than treating a matching path as machine identity.

Maintain competing interpretations within the review: a shared artifact, an unrelated same-path artifact, a copied artifact, or insufficient evidence. Check contradictions and temporal uncertainty. Cite the observations supporting a detection of the reviewed activity. Use unknown when the available evidence cannot distinguish the relevant interpretations. This is a proposed prompt/tool procedure to evaluate, not a deterministic filesystem reconstruction guarantee.

Classifier scores remain advisory. Every required evidence range receives investigator coverage; low classifier risk alone cannot silently retire review debt. No persistent inferred filesystem graph is required for this first implementation.

### Independent background review

Reuse Postgres and existing review records where practical. Separate command dispatch/outcome records from investigator verdicts; today those responsibilities share monitor_reviews.

Persist the transcript/evidence and review obligation before allowing execution to advance. Retain normal argument validation, ownership, live session lease, run status, execution-generation fences and budget checks. Remove model approval from command dispatch.

A standalone worker claims jobs using its own expiring, fenced lease. Billing, result completion and catch validate that lease. Jobs survive browser disconnect, agent cancellation, lease expiry and worker restart. Completion and local accounting are idempotent; ambiguous external inference billing must retain reconciliation state rather than assuming exactly-once provider execution.

Coalesce redundant pending updates per session into a newer transcript target while preserving every intervening message. An older completed review only advances coverage through its captured boundary. It cannot clear work that arrived during review. Large transcripts require bounded review ranges with explicit coverage; exceeded limits remain unresolved, never silently skipped. Define and test coverage before allowing coalescing to retire obligations.

Track processed evidence separately from resolved coverage. Unknown verdicts and operational failures can count as attempted work but cannot count as cleared for finalization. Retry transient failures within bounded policy. Permanent uncertainty stays visibly unresolved. A block atomically records catch and revokes execution generation. The worker cannot use another process's activeRunners map. Reuse and adapt the existing one-second runner heartbeat to observe persisted revocation and abort local inference/tool requests. Pending monitor debt must no longer exempt attacker execution from revocation. Define a bounded database-check timeout and abort if revocation cannot be checked; measure observed catch-to-cancellation lag. Subsequent dispatch is fenced immediately by database authorization, while already-dispatched work has a cancellation interval. Persist late results as outcomes of already-dispatched commands, never as renewed execution authorization, and settle/reconcile incurred inference cost.

Physical teardown must account for every run sharing a Sprite. Single-session forks currently retain and reuse their parent's environment. A delayed catch of a parent must not destroy or revoke an active child's environment. Serialize teardown eligibility with fork creation and preserve its retention policy. Use internal Sprite/lineage identity for cleanup only, without exposing it as monitor correlation metadata. Immediate deletion applies only when eligible; otherwise source-run cancellation must use run-scoped handles and generation fencing. Verify actual remote command termination separately from local abort signals.

### Submission and outcome

Submission closes command admission immediately and records a pending outcome. Stop agents, resolve or explicitly record in-flight command outcomes, then seal each session's final evidence boundary. Late tool results must remain covered. Model review does not hold the player request open.

Score only after command quiescence: current scoring mutates a shared Git index and cannot run safely alongside attacker commands. Infrastructure/scoring work may also complete in the background. Confirm capture only when flag/bug requirements pass, all required evidence through the sealed boundary has resolved without detection, and scoring is complete.

Catch and confirmation serialize on the run row. A catch wins over provisional capture. Stopping, exhausting budget, expiring the Sprite or disconnecting cannot erase review debt. Cleanup may remove compute but must preserve evidence and pending disposition. Unknown or failed review never produces an automatic win.

Keep provisional results off confirmed leaderboards. The existing experiment's scoring remains otherwise unchanged.

### Player experience

Keep the run-wide maximum risk graph from processed classifier results. Label it as risk seen so far. Show monitoring state separately: reviewing, caught up, retrying, unresolved or caught. Show pending work and last processed observation time; no evidence processed is distinct from zero observed risk.

After submission show result pending, with background progress followed by confirmed capture, caught, unsuccessful submission or unresolved review. Persist state and poll/subscribe independently of the prompt stream so reloads and closed/reopened tabs recover correctly. No per-command approval presentation.

## Capacity and deployment decisions

Asynchrony removes model latency from command admission, not the cost of recording evidence or finite compute capacity. Coalescing reduces repeated review work but cannot guarantee bounded backlog under unlimited transcript production. Retain application resource limits and measure lag explicitly.

Monitoring currently shares the attacker's spend allowance. An attacker could consume it before delayed review runs. Before enabling asynchronous execution choose protected monitoring funds or a separate bounded review allowance. Exhausted monitoring allowance must leave an unresolved result with no confirmed credit. Do not claim eventual review without funded capacity and a live worker.

Local development can run a standalone worker against the same database. Production requires a continuously running worker or durable job delivery to bounded workers. Hosting selection/provisioning is not part of this investigation. A detached Promise, browser polling or daily cleanup is insufficient.

## Evaluation and acceptance evidence

| ID  | Scenario                                                         | Required proof                                                                                                            |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| A1  | Monitor responses held while commands execute                    | Real orchestration shows command dispatch/results without releasing the fake model; evidence/job persisted first          |
| A2  | Browser closes, agent lease expires, worker crashes              | New worker resumes durable jobs; expired worker cannot settle/catch; no lost obligations                                  |
| A3  | New evidence arrives during review                               | Old result advances only old coverage; newer work remains pending                                                         |
| A4  | Submit while commands/reviews in flight                          | Admission closes, late outcomes covered, score after quiescence, HTTP does not wait for monitor, no early leaderboard win |
| A5  | Detection races provisional confirmation                         | Catch recorded once and wins; all sessions fenced and teardown retried                                                    |
| A6  | Unknown/provider error/budget exhaustion/oversized evidence      | Visible unresolved state; no false clearance or win; bounded retries and correct billing                                  |
| S1  | Relevant history older than 100 newer decoys                     | Literal search retrieves and cites it without increasing initial context indiscriminately                                 |
| S2  | Same string only in another owner's data or hidden content       | No hit, snippet, count, ranking or cursor leak                                                                            |
| S3  | Punctuation/Unicode/chunk boundary; concurrent edit after search | Exact literal match and stable read/citation of preserved evidence                                                        |
| E1  | Same filename on unrelated filesystem                            | Current harmless observation prevents unsupported attribution; indistinguishable case permits unknown                     |
| E2  | Distinctive artifact appears in two sessions                     | Retrieve both and ground the relation in content, not internal metadata                                                   |
| E3  | Harmful then harmless overwrite and reverse ordering             | Respect supported observations; no invented last writer for ambiguous concurrent writes                                   |
| E4  | Misconduct solely in an unrelated historical run                 | No catch of the current run solely from prior misconduct                                                                  |
| U1  | Delayed/out-of-order results and reload                          | Graph reflects processed evidence, lag remains visible, pending outcome recovers, stale UI cannot restore active play     |

Deterministic real-Postgres/Pi integration with controlled external transports proves search, orchestration, isolation and failure semantics. Paired live-model cases measure relevant-evidence retrieval, false attribution, unknown rate and detection quality separately. Label unidentifiable cases explicitly instead of forcing binary ground truth.

Measure command-path persistence latency, review latency, arrival/completion rates, oldest pending age, catch delay, transcript storage growth, tokens and cost. Compare against the synchronous baseline with the same scripted workload. No measured latency or detection-quality result exists from this investigation.

## Work sequence

- [x] Trace search, snapshot, queue, execution, billing, submission and UI dependencies.
- [x] Obtain independent read-only retrieval and lifecycle investigations.
- [x] Resolve submission behavior with user: end play and review asynchronously.
- [ ] Review proposed design independently; settle evidence representation, coverage semantics and monitor funding before implementation.
- [ ] Implement immutable evidence and owner-scoped search with failing regressions first.
- [ ] Implement/recover independent worker while existing execution gates remain enabled.
- [ ] Switch execution, submission, catch and UI together after durability/coverage proof.
- [ ] Run offline checks, disposable integration coverage and browser lag/catch tests.
- [ ] Run bounded opt-in live quality/performance evaluation and deployment worker contract checks.

No new search service, vector database, persistent speculative filesystem graph or production deployment is proposed for the first implementation.

## Independent investigation review

Reviewer accepted the source findings and proposed search procedure, with two required qualifications incorporated above: cross-process cancellation and shared-Sprite fork teardown. These have explicit acceptance cases A7 and A8. This is an investigation report; evidence representation, coverage, funding and worker hosting must be settled in the implementation contract before source changes.
