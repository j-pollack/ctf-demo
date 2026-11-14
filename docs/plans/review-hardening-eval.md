# Review of a killed response, and a repeatability measurement for the evals

Worktree: `/Users/jonathan/Code/ctf/.worktrees/review-hardening-eval`
Branch: `feature/review-hardening-eval`
Baseline: `44085782bfd2f6981007e58bb8cc96f239fd3578`; clean index and worktree. Primary checkout source stays unchanged. The unrelated worktree `.worktrees/play-layout` belongs to other work and is not touched.

Roles: lead is Claude Fable 5.2. Plan verifier and code reviewer are independent Claude Opus agents at high reasoning effort, read-only. The developer is a Claude Sonnet 5.5 agent at medium reasoning effort, created through Paseo.

## Request

After PR 27 merged, the user asked for two follow-ups: the killed-response hardening, and a measurement run for the evals. On 2026-11-14 the user chose a repeatability run over the paired busy/idle run first proposed, and authorized the lead to read `OPENROUTER_API_KEY` and `TYPESAFE_API_KEY` from the primary checkout's `.env.local` for it.

## Background

PR 27 made the end of an agent response the trigger for a monitor review. `releaseSessionLease` sets `monitor_jobs.ready_version = requested_version` (`lib/sessions.ts:402`). `claimMonitorJob` claims a job when its session has no live lease or when `ready_version > covered_version`, and each claim resets `ready_version` to 0 (`lib/monitor-jobs.ts:20`, `:131`).

## Workstream 1: a killed response

### Problem

A response can end without running `releaseSessionLease`. The process dies, the release throws, the prompt route fails after the claim, or the response outlives its 270-second lease and a new claim replaces it. No ready mark is set. The job is claimable only while the lease is lapsed. `claimSession` accepts a new instruction as soon as the lease lapses (`lib/sessions.ts:347`). If the new instruction arrives before a worker claims the job, the new live lease hides the earlier response's transcript until the new response ends. That adds up to one response deadline of review delay, and it repeats if the next response also ends without a release.

The lease sweeper in `lib/games.ts:410` clears lapsed leases without marking anything, so a stale lease value cannot identify these responses.

### Design

`claimSession` marks the session's unreviewed content ready in the same transaction that takes the lease, after the lease update succeeds:

```sql
UPDATE ctf.monitor_jobs SET ready_version=requested_version
WHERE game_id=$1 AND session_id=$2 AND status<>'unresolved'
```

`claimSession` has one production caller, `claimGameSession` in `lib/games.ts:835`, reached from the prompt route. Every successful call starts a response. Lock order stays games row first, then job rows, as in every other path that locks job rows. Legacy runs have no job rows, so the statement matches nothing for them.

A job is `unresolved` when its review ended unknown or its error retries ran out (`lib/monitor-jobs.ts:115`, `:186`). The predicate leaves those jobs unmarked. An append that requeues such a job resets `ready_version` to 0 in `enqueueMonitorJob`, and the content waits for the new response to end as it does today. The reset was added in the corrective cycle. Without it a mark set before the job became `unresolved` survived the requeue. Reviews are charged to the player's run budget, so re-reviewing inconclusive content at every instruction would spend that budget for a likely repeat of the same outcome. The production worker reaches `unresolved` through exhausted errors, because the flag-read investigator returns only allow or block. A response that ended without a release and appended anything has a `queued` job, so it is always marked.

Rejected alternatives. Marking only when the previous lease was never released needs a second mark in the sweeper and a way to tell a swept lease from a released one. Marking unconditionally re-reviews inconclusive content once per instruction. A `reviewed_version<requested_version` predicate misses exhausted errors, which never advance `reviewed_version`.

Accepted behavior changes, each bounded to one claim per instruction because a claim consumes the mark:

- A review that failed with an error and is waiting to retry can retry during the next response.
- A worker claim that expired before the instruction started can be reclaimed during the next response. The existing case "an expired claim is not reclaimed while its session is mid-turn" covers an expiry inside the response and still holds.
- A review in flight when the instruction starts leaves a mark behind. If it ends in an error with retries left, the content is claimable once more during the response. If it ends `unresolved`, the next append clears the mark.

The claim after a mark takes `target_version = requested_version`, so it also covers the first updates of the new response. The existing case "a finished response is reviewed once during the next turn" already accepts that.

The comment above `REVIEWABLE` in `lib/monitor-jobs.ts` names the release as the only source of the mark. It is updated to name both.

### Criteria

Every new case calls `retireOtherJobs()` first, starts the new response through the real `claimSession`, and ends it through the real `releaseSessionLease` with the lease `claimSession` returned. Before each "returns null" assertion the case asserts that the job is `queued`, `requested_version > covered_version`, the session lease is live, and `next_attempt_at <= now()`. After the release it asserts the job is claimable. The null then comes from the lease gate and nothing else.

| ID  | Given / when / then                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1  | Given an async run's session recorded updates in a response that ended without a release, and no worker claimed the job. Two variants: the lease lapsed, and the sweeper cleared it. When a new instruction claims the session. Then `ready_version` read straight after `claimSession` equals `requested_version`. When the new response appends. Then `claimMonitorJob` returns that job while the lease is live, and its `targetVersion` equals the `requested_version` after the append.                                                               |
| H2  | Given every recorded update is covered by an allow. When a new instruction claims the session and appends one update. Then `claimMonitorJob` returns null while the lease is live. A response's own updates are never exposed by the mark set at its start.                                                                                                                                                                                                                                                                                                |
| H3  | Given the H1 claim finishes allow, unknown or error. When more updates land in the same response, and a second `claimSession` is refused with 409. Then `claimMonitorJob` returns null until the response ends. One mark yields one claim.                                                                                                                                                                                                                                                                                                                 |
| H4  | Given the previous response was released and its job is `unresolved`. Four variants: one unknown review after the release; three error reviews after the release, with `next_attempt_at` forced between claims; an unknown review during the response, before the release; a third claim that expired during the response and was retired as exhausted after the next instruction started. When a new instruction claims the session and appends. Then `claimMonitorJob` returns null while the lease is live. Inconclusive content costs no extra review. |
| H5  | Given the previous response was released and its review ended in an error with a retry pending. When a new instruction claims the session and appends. Then `claimMonitorJob`, called after the append, returns the job once. After that claim finishes without an allow and another update lands, it returns null until the response ends.                                                                                                                                                                                                                |
| H6  | The existing turn-end cases in `tests/integration/async-backend.test.ts` and `tests/integration/sprites.test.ts` pass unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| H7  | Given a run with two sessions, where the sibling holds a live lease and has an unreviewed update. When the other session takes a new instruction. Then the sibling's job has `ready_version` 0 and `claimMonitorJob` does not return it. The mark is scoped to the claimed session.                                                                                                                                                                                                                                                                        |

## Workstream 2: lease state and the evals

### Finding

The eval harness seeds a target session with a live lease. Production now reviews targets that are idle or in their next response. The measurement first proposed was a paid paired run, one arm per lease state.

That run cannot show a difference, because the harness would vary only the lease and the lease is not an input to the production investigator or the classifier. The plan verifier confirmed this independently.

- In `lib`, `busy` is computed in the snapshot (`lib/monitor-snapshot.ts:55`, `:232`) and read in one place, `publicSession` in `lib/monitor-tools.ts:205`. Its callers are reached only from the legacy review, `runMonitorReview`.
- The production worker calls `runFlagReadInvestigation`. Its prompt is the target and the initial evidence from `createTranscriptInvestigationTools`: the target alias, observation ref, schema text, transcript excerpt and scope (`lib/transcript-query.ts:135`). The SQL projection holds aliases, refs, sequence numbers, `observed_at`, message counts and message text.
- The provider request body holds the model, messages, a session id built from the session and review ids, reasoning, provider and `max_tokens`.
- The classifier sends the target's messages. A review passes a job claim, and with a job claim the lease is not consulted.

The lead's earlier statement that the investigator sees `busy` described the legacy tool set.

One production difference between a review during a response and a review after release is not covered by the lease. While a response runs, the agent's reservations raise `games.reserved_microdollars`, which lowers the review's allowance. The result is a smaller `max_tokens` or a refused review recorded as an error. The harness seeds no agent reservations, so no eval run measures this.

### Guard

| ID  | Given / when / then                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | Given the eval harness reviews a target session that holds a live lease. When the investigator and classifier requests reach the provider fakes. Then no raw request body carries a `busy` key, in plain or escaped JSON, and none carries a lease value present in `ctf.agent_sessions` or `ctf.games`. The set of lease values is asserted non-empty. A recorded mutation run that adds the target's `busy` to `initialEvidence` in `lib/transcript-query.ts` fails on the G1 assertion's own message, and the mutation is reverted. |

Host: `tests/integration/flag-read-eval.test.ts`, whose fake sees both provider requests and whose targets hold a 30-minute lease.

## Workstream 3: repeatability run

### Question

Before PR 27 a session was reviewed several times during a response. Now each finished response gets one review. Run 003 passed 72 of 72 dev cases in one pass per case. The run measures how often a single review of the same case gives a different result.

### Protocol

- Three sequential passes of the 72-case dev split under the production policy, strategy `closed-world-presumption`, through `scripts/flag-read-baseline-run.ts`. One investigation per case per pass. No retries, no replacement of failed cases, no change to prompt, corpus or policy.
- The runner accepts only `current` and `closed-world-presumption-v1` today (`scripts/flag-read-baseline.ts:24`). Run 003 evaluated `closed-world-presumption-v1`, the v13 evaluation framing. Production runs `closed-world-presumption`, the v14 game-contract framing, which differs by three phrase replacements (`lib/flag-read-policy.ts:102`) and has never been run against the corpus. Criteria E1 and E2 add it to the runner. The corpus cases are fresh seeded runs with no forks, which is the scope the game contract states, so the labels apply.
- A new frozen schedule, `evals/flag-read/closed-world-presumption-digitalocean-90s-repeatability-schedule.json`, generated by `scripts/flag-read-baseline.ts` from the final reviewed commit with a clean tree. That commit is recorded here. Any later change under `lib`, `scripts` or `db` invalidates the schedule, and the runner fails closed. The existing schedules stay byte-identical. They reject the current sources, as intended.
- Stop budget $2 per pass, $6 total. Expected spend is $1.35 from run 003's $0.45.
- Each pass uses a fresh empty `ctf_integration_*` database in a disposable `postgres:17-alpine` container bound to 127.0.0.1. The shared database is never used. The two provider keys come from the process environment and are never written to a file or printed.
- The DigitalOcean endpoint and its prices are checked against the frozen ceilings before the first pass. A failed prerequisite, a source hash mismatch, an accounting overrun, or a pass whose `summary.json` status is not `completed` stops the launch of later passes.
- Output goes to `/Users/jonathan/Code/ctf/.artifacts/review-repeatability/pass-{1,2,3}`, which is ignored by git and survives worktree removal. The parent directory is created first and each pass directory must not exist. The databases are kept until accounting is reconciled, then the container is removed.

### Criteria

| ID  | Given / when / then                                                                                                                                                                                                                                                                                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | Given the strategy `closed-world-presumption`. When a schedule is built and the runner dry-runs it. Then the schedule records the production monitor version and prompt hash, which differ from the v1 values, and the dry-run accepts it. Unknown strategies are still rejected. The five existing schedule files are byte-identical. |
| E2  | Given provider fakes and a disposable database. When the runner executes a live pass under `closed-world-presumption`. Then every entry carries the production strategy, monitor version and prompt hash, the investigator request carries the production prompt, and the summary status is `completed`.                               |

### Report

Fixed before the run. A case's result in a pass is `flagReadDetected` true or false. A skipped case, a null result or an operational error is reported separately and excluded from disagreement counts. A case is unstable when its completed passes disagree. Presumption labels are the primary standard, matching run 003, and strict labels are secondary. Per pass: both scores, operational failures, spend and holds. Per case: the three results side by side for every unstable case and for every case that is wrong in all completed passes. Counts of positives missed in at least one pass and of negatives flagged in at least one pass, with denominators. Three passes over one synthetic corpus are correlated observations. The report gives counts and no confidence interval. A case wrong in every pass points at the prompt framing, since run 003 scored it correctly under v13. One pass of v13 is the only reference, so that attribution is tentative.

### Results

Run on 2026-11-14 from 16:43 to 17:07 UTC at commit `c3d1c9850a4c3f2a8eab5bf63e45e0b3632e9f11`. The schedule file's SHA-256 is `8e6e505a7b41aabc8ec39f53419e6fa1e3f591d8b99e095edfd00ab8e5799202`. The policy was `investigator-v14-glm53-jev114-presumption-digitalocean`, prompt hash `2b36e1c16706456ab155fd57cd16b7151558ca933f32e89885b4e5efc880668d`. The public endpoint listing showed DigitalOcean at the frozen ceilings before the first pass.

| Measure                          | Pass 1    | Pass 2    | Pass 3    |
| -------------------------------- | --------- | --------- | --------- |
| Completed cases                  | 72 of 72  | 72 of 72  | 72 of 72  |
| Presumption positives detected   | 39 of 39  | 39 of 39  | 39 of 39  |
| Presumption negatives flagged    | 0 of 33   | 0 of 33   | 0 of 33   |
| Strict positives detected        | 29 of 29  | 29 of 29  | 29 of 29  |
| Strict unsupported findings      | 10        | 10        | 10        |
| Operational errors, skips, holds | 0         | 0         | 0         |
| Investigator calls               | 151       | 151       | 153       |
| Mean case latency                | 6.58 s    | 6.78 s    | 6.13 s    |
| p95 case latency                 | 16.22 s   | 11.72 s   | 10.31 s   |
| Slowest case                     | 25.78 s   | 22.81 s   | 12.08 s   |
| Settled spend                    | $0.453833 | $0.452490 | $0.437822 |

No case was unstable. Every case gave the same result in all three passes, and every result matched its presumption label. That is 117 completed reviews of positive cases with no miss and 99 completed reviews of negative cases with no flag. The ten strict unsupported findings are the ten positives that the presumption labels add, as in run 003. They were the same ten cases in every pass.

Total settled spend was $1.344145 against the $6 ceiling, with nothing held. Each pass database agrees with its journal: 223, 223 and 225 inference rows, all settled, no charge above its reservation, 72 classifier rows per pass. Every model request returned HTTP 200. Every review row carries the v14 prompt version.

The production v14 framing scores the same as run 003's v13 framing on this corpus.

### Held-out pass

The user approved one pass of the 40-case test split under the same policy. It ran on 2026-11-14 from 17:19 to 17:23 UTC at commit `4426961222027fc5b8d82e06213386136b9636cb` with schedule `evals/flag-read/closed-world-presumption-digitalocean-90s-heldout-schedule.json` and a $1 stop budget.

All 40 cases completed. All 18 positives were detected and none of the 22 negatives was flagged. Strict and presumption labels agree on this split. There were no operational errors, skips or holds. Mean case latency was 4.74 s and the slowest case took 17.00 s. Settled spend was $0.188246 across 106 inference rows, and the pass database agrees with the journal. The v13 framing scored 40 of 40 on this split earlier. This split has now been run twice and is no longer unseen.

### Limits of the result

- Three passes over one synthetic corpus are correlated observations of 72 fixtures. Zero misses in 117 positive reviews does not bound the miss rate on real play. With independent reviews it would be consistent with a per-review miss rate of a few percent.
- The dev cases were written and tuned alongside the presumption policy. The held-out pass is one pass of 40 cases from the same generator.
- Each case is one whole synthetic transcript with ample budget. No eval covers a review that competes for run budget. A read-only investigation after this run found a defect there: a review refused for lack of available budget counts as an error, three attempts pass within about six seconds, and the job ends `unresolved`, which nothing requeues in a finalizing run. The fix is separate work on its own branch.
- The provider pin and price caps were sent on every request. Generation metadata was not sampled to confirm the serving provider, which run 003 did for five calls.
- Artifacts are local and untracked: `/Users/jonathan/Code/ctf/.artifacts/review-repeatability/` holds `pass-{1,2,3}/` with `schedule.json`, `run.json`, `entries.jsonl` and `summary.json`, the three pass logs, `analysis.json`, `analyze.mjs` and `run.sh`. The disposable container was removed after reconciliation.

## Review outcomes

- Plan verification: three rounds by an independent Opus agent. Round one required pinned preconditions in H2 and H3 and a G1 assertion that catches escaped JSON. Round two found that the first narrowed predicate, `reviewed_version<requested_version`, missed exhausted errors, and that production's prompt had never been evaluated. Round three approved.
- Code review: one P2, no P0 or P1. A mark set before a job became `unresolved` survived the requeue. One corrective cycle fixed it in `enqueueMonitorJob`, tests first. Re-review found the P2 resolved and no P0 to P2 remaining.
- Remaining P3, no action taken: in H7 the claiming session's id equals its game id, so the test would not catch swapped parameters in the new statement.

## Non-goals

- Investigator timing, the frozen 90/15/120 policy, worker concurrency.
- Changes to the eval corpus, existing frozen schedules, or harness lease handling. No released-lease arm.
- Removing `busy` from the legacy review tools.
- Measuring review allowance under live agent reservations.

## Checks

| Criterion         | Check                                                                                                                                                                                                                                                                                                                                | Evidence                                                                                                                                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1 to H5          | New cases in `tests/integration/async-backend.test.ts` beside the turn-end cases. Red run recorded before the change: H1 fails on `ready_version` 0, H3 inherits H1's null claim, H5 fails on a null claim. H2 and H4 pass before and after, which their pinned preconditions make meaningful. H4 fails under an unconditional mark. | Red: 7 of 9 new cases fail before the change. Both H1 variants fail on `ready_version` 0, the three H3 cases and H5 on a null claim, H2 and both H4 variants pass. Green: file passes 56 of 56.                                                          |
| H6                | `npm run test:integration` full run.                                                                                                                                                                                                                                                                                                 | Lead run: 309 of 309 pass.                                                                                                                                                                                                                               |
| H4, H7 corrective | Code review found one P2: a mark set before a job became `unresolved` survived the requeue, so H4 failed in two orderings. Third and fourth H4 variants and H7 added, tests first. Fix: `enqueueMonitorJob` resets `ready_version` on the unresolved-to-queued transition.                                                           | Red: both new H4 variants fail inside `assertGated`, the job is returned where null is expected. H7 passes before and after. Green: file passes 59 of 59. Lead runs after the fix: check 280 of 280, integration 312 of 312, build exit 0, probe exit 0. |
| G1                | Assertion in `tests/integration/flag-read-eval.test.ts`. Mutation run recorded and reverted.                                                                                                                                                                                                                                         | Mutation run fails with "session lease state must not reach the model: busy key in a provider request". Reverted, file passes.                                                                                                                           |
| All               | `npm run check`; `npm run build`; worker import probe `env -i PATH="$PATH" NODE_ENV=production node --import tsx -e "await import('./lib/monitor-worker.ts')"`. `npm run test:coverage` measures unit tests, and this change adds none, so it is not run.                                                                            | Lead runs: `npm run check` 280 of 280, build exit 0, probe exit 0.                                                                                                                                                                                       |
| E1, E2            | Unit cases in `tests/flag-read-baseline.test.ts` or `tests/flag-read-baseline-run.test.ts`. One mode in `tests/integration/flag-read-baseline.test.ts` that reuses the candidate wrapper case with the production strategy. Red run recorded: the strategy is rejected before the change.                                            | Red: "Baseline strategy must be current or closed-world-presumption-v1." in two unit cases and the `production-wrapper` mode. Green: unit 280 of 280, integration file 26 of 26. `git status --short evals/` empty.                                      |
| W3                | Schedule dry-run passes on the committed sources. Three `summary.json` files with status `completed`. Journal totals reconcile with the databases.                                                                                                                                                                                   | Dry-run passes at `c3d1c98`. Three summaries with status `completed`. Each pass database matches its journal on settled spend, holds and inference row count.                                                                                            |

## Steps and ownership

1. Developer adds the H1 to H5 cases and records the red run. Owns `tests/integration/async-backend.test.ts`.
2. Developer adds the statement to `claimSession` and updates the `REVIEWABLE` comment. Owns that function in `lib/sessions.ts` and that comment in `lib/monitor-jobs.ts`.
3. Developer adds the G1 assertion and records the mutation run. Owns `tests/integration/flag-read-eval.test.ts`, plus a temporary edit to `lib/transcript-query.ts` that must be reverted.
4. Developer adds the production strategy to the runner, tests first. Owns `parseBaselineStrategy`, the `BaselineStrategy` type and the usage strings in `scripts/flag-read-baseline.ts` and `scripts/flag-read-baseline-run.ts`, and the three test files named in the Checks table.
5. Lead reruns every gate, commits a checkpoint, and sends the full delta to the code reviewer.
6. Lead generates and commits the schedule, runs the three passes, analyzes them and records the results here.

No migration. No push or deployment without the user's authorization.
