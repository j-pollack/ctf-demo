# Investigator requests stream

- Worktree: `/Users/jonathan/Code/ctf/.worktrees/investigator-stream`
- Branch: `feature/investigator-stream`, stacked on `feature/investigator-confirm` at `54818d9`
- Status: contract verified with changes folded in, not built
- Ships in pull request 37.

## Problem

An investigator request is sent without streaming and is aborted 90 seconds after it starts. The bound is the `deadline` in `infer` in `lib/inference.ts`.

- A response of 8,192 tokens, the output limit, needs 91 tokens a second to finish in time. On 2026-11-21 the provider produced between 73 and 231 tokens a second on the user's run, and full responses took 35 to 74 seconds.
- In the rerun of E2 of `docs/plans/investigator-confirm.md`, five of the ten replays of the user's run `0496a49a` were aborted by this bound. The measurements earlier the same day had none. A review was aborted after up to 351 seconds of work and $0.116 of spend, and the game would start it again from the beginning.
- A response that is not streamed delivers its generation id at the end. An aborted request has none, so `reconcileInference` skips its hold. `expireUnverifiableHolds` settles it at its ceiling at the first `cleanup()` more than 24 hours later. `cleanup()` runs from a daily cron, at a game's start and at the end of an agent response. The five aborted reviews left holds of $0.056 to $0.221.
- While a run has a hold, `claimAsyncFinalization` does not claim it and the leaderboard does not list it. A submitted run whose final review loses one request this way waits a day or more for its result and keeps its environment slot. The no-result path of step 4a does not wait on holds.

## Decisions by the user

- 2026-11-21: the monitor reasons until it is legitimately done. A cut-off is continued with its reasoning.

## Goal

An investigator request ends when the model has answered, when the stream has stalled, or when the review's own deadline passes. A request that is cut leaves a hold that the worker settles from the provider's record a few minutes later, and no hold outlasts a day.

## Design

### Every request streams

- `infer` sends every request as a stream and assembles it with `collectStream`. The branch that reads a whole response and the 90 second bound are removed. The runner already streams every agent request, so the agent's requests do not change.
- A request with role `monitor` has no delta handler. `infer` passes `collectStream` one that does nothing. `agentStream` and its call in `lib/investigator-driver.ts` keep their arguments.
- The assembled response goes through the same usage check, settlement, reasoning handling and tool call parsing as today, including the call that is dropped when a monitor response is cut off inside its arguments.
- The generation id is stored on the request's `ctf.inference` row when the first chunk carries it.

### Time bounds for role `monitor`

- No timer is derived from the run's lease. The lease of a run in `finalizing` can be null or past, and the agent's lease bound would abort every request at once. That bound stays for role `agent` only.
- The request ends early in three ways:
  - the stream sends nothing for the idle bound, keep-alive comments included;
  - the response headers have not arrived within the idle bound after the request was sent. A timer aborts the fetch and is cleared when the headers arrive;
  - the caller's signal aborts. For a review that is the 10 minute deadline of `docs/plans/investigator-completion.md` and the job claim.
- The idle bound is `STREAM_IDLE_MS`, 45 seconds. `InvestigatorTiming` gains an optional `streamIdleMs`, validated to be at most `STREAM_IDLE_MS`, and it reaches `infer` through the review input, the driver and `TrustedInferenceOptions`. Tests shorten it. The game never sets it.
- A stall of either kind fails the request with "The investigator's model stopped responding." and status 504. `collectStream` takes the message as a parameter, and the agent's message stays as it is.
- The mapping of a timeout to "The agent ran out of time for this response." applies to role `agent` only. A review deadline that passes mid-stream fails as it does today.
- The review fails as it does for any failed request, and the job is retried.
- The investigator has no retry inside a request. A status 429 before the stream fails the request, releases its hold, and the job is retried, as today.

### Holds

- A request aborted after its id arrived is settled by `reconcileInference` from the provider's generation record. That function skips a row younger than 2 minutes and tries a row again after 5 minutes.
- The worker calls `reconcileInference()` in the pass that looks for a finalization to claim, while a finalization job is queued. A run that nobody has open is then settled by the worker.
- `expireUnverifiableHolds` settles at its ceiling any hold older than 24 hours, with or without a generation id. Today a hold with an id whose record never becomes usable is never released.
- A request aborted before any chunk has no id and waits for that expiry, as today.

### Unchanged

- The output limit of 8,192, the request limit of 32, the continuation after a cut-off and the read confirmation.
- Cost, the monitor version string and the three policy hashes.

## Measurement

- E1, after the build, live: ten replays of the user's run `0496a49a` with `v15-unknown`, the inputs `cases-part1.json` to `cases-part5.json` in `/Users/jonathan/Code/ctf/.artifacts/investigator-length/`. Recorded per review: verdict, requests, continuations, read confirmation, time, cost, and any hold left. Acceptable when no review fails on a request time bound, every continued response carries its reasoning into the next request without a provider error, no review fails on an invalid tool call, and the verdicts are no worse than the rerun's 4 right in 5 completed.
- E2, live: the three regression sets, at least 26 of 27, 21 of 21 and 12 of 12, and every real read kept.
- E3, live: one request on the investigator's endpoint aborted on purpose after its first chunk. Recorded: how long the provider's generation record takes to appear, and whether it has `cancelled` or `finish_reason`, native token counts and `total_cost`, which is what `reconcileInference` needs to settle it. If it does not, the 24 hour expiry is the only release and the contract says so.

## Out of scope

- Showing the investigator's reasoning to anyone while it arrives.
- Retrying a single stalled request inside a review.
- The false catch that the read confirmation kept in the rerun.

## Acceptance

Integration tests use the real worker, real Postgres and provider fakes only. Every fake asserts that the request carries `stream: true` and answers with server-sent events. One helper in `tests/integration/` turns a completion into events, with optional splitting into fragments. `scripts/smoke.ts` keeps its own `controlledReply`, which already does this.

- S1. A review of a session with no read ends as an allow from a streamed response. Its stored reason, evidence, request count and settled cost equal those the same completion produced before the change.
- S2. A streamed response whose reasoning details and tool call arrive in several fragments is assembled into one call with valid arguments. A response cut off at the output limit is continued, and the next request's assistant message carries reasoning details equal to the reassembled ones. A response cut off inside a tool call's arguments, split across chunks, has that call dropped and is continued.
- S3. With an idle bound of 200 milliseconds, a stream that lasts 2 seconds with gaps of 100 milliseconds completes the review.
- S4. A stream that goes silent for the idle bound fails the review with the stall message. The request's row has the generation id from its first chunk and the hold is open. With the row's `created_at` set 3 minutes back, a first generation lookup that answers 404 leaves the hold open. A later lookup that answers `cancelled: true` with token counts and a cost settles it, the run's `reserved_microdollars` is 0, and `claimAsyncFinalization` then claims the run.
- S5. A request whose headers never arrive fails within the idle bound with the stall message, not at the review deadline. Its row has no generation id and its hold is open.
- S6. A streamed error event fails the review as a provider error does today. A status 429 before the stream fails the request with no retry inside it, releases the hold, and the job is retried.
- S7. The agent's requests are unchanged: the lease bound, the stall message and the "ran out of time" message.
- S8. A review deadline that passes mid-stream fails the review. The row has its generation id, and the failure is not the agent's "ran out of time" message.
- S9. A stream that ends with no usage chunk fails with "Inference usage could not be verified", keeps the hold with its id, and reconciliation settles it.
- S10. A review of a run in `finalizing` whose `lease_until` is null completes.
- S11. The worker, with a finalization job queued behind a hold that has a generation id, settles the hold through a faked generation record and finalizes the run, with no request to the run's page.
- S12. A hold older than 24 hours with a generation id is settled at its ceiling by `cleanup()`.
- G1. `npm run check`, `npm run test:integration`, `npm run build` and `npm run test:coverage` pass. The monitor fakes in these files answer with events: `async-backend`, `async-worker-preload`, `flag-read-baseline`, `flag-read-call-limit`, `flag-read-eval-options`, `flag-read-eval`, `flag-read-production`, `flag-submission-lifecycle`, `held-worker-preload`, `sprites` and `worker-idle-wake` under `tests/integration/`. The assertion in `async-worker-preload.ts` that a monitor request carries no `stream` field is reversed, as is the one in `scripts/smoke.ts`.
- G2. The opt-in real-timing modes of `tests/integration/flag-read-production.test.ts` follow the new bounds. `slow-success` streams keep-alive comments and tokens for 95 seconds and then succeeds. `deadline` sends no headers and expects the stall message after about 45 seconds, an open hold and no generation id. The lead runs both once.

## Risks

- The provider's stream may deliver reasoning details differently from its whole response. `mergeFragment` lets a later fragment overwrite a field that is not text, so a late `signature: null` would erase a signature. The continuation sends the details back, so a difference shows as a provider error or a lost reasoning trace. E1 checks it.
- A provider that omits the index on parallel tool calls would have them merged into one invalid call, and the review would fail. E1 checks it.
- A stream that keeps sending keep-alive comments and no tokens runs until the review's deadline.
- A hold settled at its ceiling after 24 hours can overstate what the request cost.
- The worker makes up to five requests to OpenRouter's generation endpoint per pass while a finalization waits on holds. Each row is tried once in 5 minutes.
- Eleven test files fake the provider for monitor requests and all change.

## Evidence

- Measured by the lead on 2026-11-21 from the E2 rerun outputs `rerun-replay1.json` to `rerun-replay5.json` in `/Users/jonathan/Code/ctf/.artifacts/investigator-length/` and from OpenRouter's generation records for their requests. Full responses of 8,192 tokens took 35.5 to 73.6 seconds. The aborted requests have no generation record.
- Plan verification, 2026-11-21. Verdict: ready with changes, four blocking findings, all folded in.
  - The investigator has no retry on status 429 inside a request. The driver passes `singleAttempt`.
  - The streamed path's time bound comes from the run's lease, which is null or past while a run finalizes. Role `monitor` now has no lease timer, and each branch that depends on streaming is named.
  - The opt-in real-timing suite delays 95 seconds before any headers in two modes and would fail. G2 names it.
  - `reconcileInference` ran only from the run's page and from `cleanup()`, and a hold with an id was never expired. The worker now reconciles while a finalization waits, and the expiry covers every hold.
  - Also folded in: the corrected account of when a hold settles and what it blocks, the idle bound's seam through `InvestigatorTiming`, the removal of the branch for whole responses, the existing event builders, and eight acceptance cases.
  - The verifier checked that a request cannot outlive the 660 second claim, that a drain does not abort a review, that the routing fields and `stopOnReservationOverrun` work with streaming, and that the streamed and whole responses go through the same parsing code.
  - Not verified: whether OpenRouter returns a generation id in a response header for a request that is not streamed.
