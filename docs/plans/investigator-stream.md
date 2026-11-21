# Investigator requests stream

- Worktree: `/Users/jonathan/Code/ctf/.worktrees/investigator-stream`
- Branch: `feature/investigator-stream`, stacked on `feature/investigator-confirm` at `54818d9`
- Status: draft contract, not verified, not built
- Ships in pull request 37.

## Problem

An investigator request is sent without streaming and is aborted 90 seconds after it starts. The bound is the `deadline` in `infer` in `lib/inference.ts`.

- A response of 8,192 tokens, the output limit, needs 91 tokens a second to finish in time. On 2026-11-21 the provider produced between 73 and 231 tokens a second on the user's run, and full responses took 35 to 74 seconds.
- In the rerun of E2 of `docs/plans/investigator-confirm.md`, five of the first eight replays of the user's run `0496a49a` were aborted by this bound. The measurements earlier the same day had none. A review was aborted after up to 351 seconds of work and $0.116 of spend, and the game would start it again from the beginning.
- A response that is not streamed delivers its generation id at the end. An aborted request has none, so its hold cannot be reconciled with the provider. `expireUnverifiableHolds` settles it at its ceiling after 24 hours. The five aborted reviews left holds of $0.056 to $0.221.
- While a run has a hold it cannot finalize: `claimAsyncFinalization` requires `reserved_microdollars = 0`. A submitted run whose final review loses one request this way waits up to 24 hours for its result and keeps its environment slot.

## Decisions by the user

- 2026-11-21: the monitor reasons until it is legitimately done. A cut-off is continued with its reasoning.

## Goal

An investigator request ends when the model has answered, when the stream has stalled, or when the review's own deadline passes. A request that is cut leaves a hold that settles from the provider's record within minutes.

## Design

- `infer` sends every request with role `monitor` as a stream and assembles it with `collectStream`, as it does for the agent. The assembled response goes through the same usage check, settlement, reasoning handling and tool call parsing as today. Nothing is shown while it arrives.
- The generation id is stored on the request's `ctf.inference` row when the first chunk carries it, as it is for the agent.
- A request with role `monitor` has no fixed time bound. It ends early in three ways:
  - the stream sends nothing for `STREAM_IDLE_MS`, 45 seconds, keep-alive comments included;
  - the response headers have not arrived `STREAM_IDLE_MS` after the request was sent;
  - the caller's signal aborts. For a review that is the 10 minute deadline of `docs/plans/investigator-completion.md` and the job claim.
- A stall fails the request with "The investigator's model stopped responding." and status 504. The review fails as it does for any failed request, and the job is retried.
- The agent's requests do not change: their bound stays the session lease and their stall message stays as it is.
- A request that is not streamed keeps the 90 second bound. After this change no caller in the game sends one.
- A request aborted after its id arrived is settled by `reconcileInference` from the provider's generation record, as an agent's is. A request aborted before any chunk has no id and is handled as today.
- The retry on status 429, the output limit of 8,192, the request limit of 32, the continuation after a cut-off and the read confirmation do not change.
- Cost does not change. The monitor version string and the three policy hashes do not change.

## Measurement

- E1, after the build, live: ten replays of the user's run `0496a49a` with `v15-unknown`, the inputs `cases-part1.json` to `cases-part5.json` in `/Users/jonathan/Code/ctf/.artifacts/investigator-length/`. Recorded per review: verdict, requests, continuations, read confirmation, time, cost, and any hold left. Acceptable when no review fails on a request time bound, every continued response carries its reasoning into the next request without a provider error, and the verdicts are no worse than the prototype's 10 of 10.
- E2, live: the three regression sets, at least 26 of 27, 21 of 21 and 12 of 12, and every real read kept.
- E3, live: one request aborted on purpose after its first chunk. Its row has a generation id, and `reconcileInference` settles it from the provider's record.

## Out of scope

- Showing the investigator's reasoning to anyone while it arrives.
- Retrying a single stalled request inside a review.
- Running `reconcileInference` from the worker. It runs from the cleanup route and from the run's page, as today.
- The 24 hour settlement of a hold that never received an id.

## Acceptance

Integration tests use the real worker, real Postgres and provider fakes only. A fake that receives a streamed request answers with server-sent events. One shared test helper turns a completion into events.

- S1. A monitor request is sent with `stream: true`, and a review of a session with no read ends as an allow from a streamed response. Its stored reason, evidence, request count and settled cost equal those of the same response sent whole.
- S2. A streamed response whose reasoning and tool call arrive in several fragments is assembled into one call with valid arguments, and a response cut off at the output limit is continued with its reasoning in the next request.
- S3. A streamed response that takes longer than 90 seconds in total, with no gap of `STREAM_IDLE_MS`, completes. The test shortens the idle bound through a narrow seam and does not sleep 90 seconds.
- S4. A stream that goes silent for the idle bound fails the review with the stall message. The request's row has the generation id from its first chunk, the hold is still open, and `reconcileInference` settles it from a faked generation record.
- S5. A request whose headers never arrive fails after the idle bound with the stall message, and its row has no generation id.
- S6. A streamed error event fails the review as a provider error does today, and a status 429 before the stream is retried as today.
- S7. The agent's requests are unchanged: same bound, same stall message, same stream.
- G1. `npm run check`, `npm run test:integration`, `npm run build` and `npm run test:coverage` pass. Every monitor fake in `tests/integration/` and `scripts/smoke.ts` answers a streamed request with events. The assertion that a monitor request carries no `stream` field is reversed.

## Risks

- The provider's stream may deliver reasoning details differently from its whole response. The continuation sends them back, so a difference shows as a provider error or a lost reasoning trace. E1 checks it.
- A stream that keeps sending keep-alive comments and no tokens runs until the review's deadline.
- Eleven test files fake the provider for monitor requests and all change.

## Evidence

- Measured by the lead on 2026-11-21 from the E2 rerun outputs `rerun-replay1.json` to `rerun-replay4.json` in `/Users/jonathan/Code/ctf/.artifacts/investigator-length/` and from OpenRouter's generation records for their requests. Full responses of 8,192 tokens took 35.5 to 73.6 seconds. The aborted requests have no generation record.
- `collectStream`, `STREAM_IDLE_MS` and the agent's streamed path are in `lib/inference.ts`. `reconcileInference` and `expireUnverifiableHolds` are in `lib/games.ts`. The finalization condition is in `claimAsyncFinalization` in `lib/async-finalization.ts`.
