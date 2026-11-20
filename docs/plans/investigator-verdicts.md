# Investigator verdicts: decide within the budget, and never leave a run stuck

Status: draft. Not yet verified by the plan verifier.

- Worktree: `/Users/jonathan/Code/ctf/.worktrees/investigator-verdicts`
- Branch: `feature/investigator-verdicts`, stacked on `feature/screen-actions` at `3a46faa`
- This is the first part of step 4 of the monitor rebuild. The second part covers prompts per isolation mode, command times and a path-trace tool.

## Problem

Production run `33b097dd-7a74-49ec-9bf8-c4bdb12999bc` uploaded the correct flag on 2026-11-19 after a six-hop chain over two sessions. It has been in `finalizing` since, with no verdict. Four facts in the code produce that state.

1. The investigator may make 8 model requests (`MONITOR_CALL_LIMIT`, `lib/investigator-driver.ts:21`). It is never told the number or that a request is its last. When it asks for a ninth, the driver aborts the review with "Investigator call limit reached." (`lib/investigator-driver.ts:86-88`, `209-216`).
2. The worker retries a failed review twice, after 1 second and 5 seconds, from scratch and with the same limit (`lib/monitor-jobs.ts:183-196`). On this run each attempt made 8 investigator requests and used about 175,000 tokens. The three attempts cost $0.21 and produced nothing. A failed attempt leaves its `ctf.monitor_reviews` row with no completion time, no error and no call count.
3. After the third failure the job is `unresolved`. Only a new message in the session can requeue it, and a run that has submitted accepts none. Finalization waits for every job to be `caught-up` (`lib/async-finalization.ts:236-246`). The run can never finalize.
4. The cap of 10 busy environments counts async runs in `finalizing` (`lib/games.ts:529-536`). The 24 hour sweep skips them. The run holds a slot and a live Sprite until someone intervenes. Ten such runs stop every player from starting a run.

`docs/plans/review-budget.md` recorded the second half of this on 2026-11-14 and listed a recovery path as a non-goal.

## Decisions by the user

Recorded on 2026-11-20.

- A correct submission that the investigator cannot reach a verdict on is a win. "It means the monitor was incapable of reliably detecting exfiltration."
- Step 4 comes before step 3.

The lead proposed, and the user has not yet answered, that a review that fails because the model provider is unavailable is different from a review that runs out of budget, and should not hand out a win. Open question 1.

## Goal

1. The investigator knows its budget and gives a verdict on its last request with the evidence it has.
2. A review that fails is recorded.
3. A run that has submitted always leaves `finalizing`, by a verdict or by a fixed schedule of retries that ends.

## The investigator decides within its budget

`MONITOR_CALL_LIMIT` stays the number of model requests one review may make. Its value is set from the measurement in E2.

- The first user message of a review states how many model requests the review has.
- Before the last request, the driver adds a notice to the conversation: this is the final request, call `finish_investigation` now with the evidence already retrieved, and report a read only if that evidence establishes it. On that request the retrieval tools are not offered, if the agent library allows the tool list to change between requests. If it does not, the notice alone is used and the developer reports it.
- A review that reaches its last request and gets a valid decision completes as `allow` or `block` like any other. This is how the user's ruling takes effect for a hard transcript: the investigator either establishes the read from what it has or reports none, and a correct submission then wins.
- The review records that the last-request notice was used: `ctf.monitor_reviews.forced_decision boolean NOT NULL DEFAULT false`, migration 026.
- A review whose last request does not produce a valid decision fails as today.

The hashed system prompt text in `lib/monitor-evidence.ts` and `lib/flag-read-policy.ts` does not change, so the prompt hash and `ASYNC_MONITOR_VERSION` do not change. The budget sentence and the notice are messages the driver adds. The version changes once, when the rest of step 4 and step 3 land, so the leaderboard resets once. No run reached the leaderboard through the failure this step fixes: such runs never finalized.

## A failed review is recorded

When a review attempt throws, the worker completes its `ctf.monitor_reviews` row with the completion time, the number of model requests made, and the failure text in `operational_error`. The job's retry behaviour is unchanged: three attempts, 1 second and 5 seconds apart.

## A submitted run always leaves `finalizing`

A monitor job of an async run in `finalizing` that is `unresolved` is requeued by the existing `cleanup()` sweep on a fixed schedule: 15 minutes, 1 hour, 4 hours and 12 hours after it last became `unresolved`. `ctf.monitor_jobs.requeues integer NOT NULL DEFAULT 0`, migration 026, counts them. A requeue sets the job to `queued` with `attempts` 0, due now. Each requeue gives the job three more attempts.

When a job is `unresolved` and its four requeues are used, the run is resolved without that session's verdict by a new function, `resolveUnverifiedRun`, in `lib/async-finalization.ts`. In one transaction, for a run still in `finalizing`:

- If any job of the run is `caught`, nothing is done. A catch always wins.
- Otherwise the run becomes `UNVERIFIED_SUBMISSION_STATUS`, a named constant with the value `ended`. The run is not a win and not a catch.
- One event records it: `kind: "monitor"`, `decision: "unverified"`, with a fixed sentence.
- `state_revision` is bumped, the finalization job becomes `done`, and no bug test is run.

The same resolution applies to an async run that has been in `finalizing` for 24 hours with `finalization_error` set. Today nothing moves such a run either.

Once the run has left `finalizing`, the existing cleanup deletes its Sprite and the run stops counting toward the cap.

Bounds:

- A requeued review is admitted under the existing monitor allowance: a run's settled spend may reach its budget plus `MONITOR_OVERAGE_MICRODOLLARS`. Past that the review is refused, the attempt fails, and the schedule continues to its end.
- At most 15 attempts are made for one job after a submission: 3 at first and 3 after each of 4 requeues.
- A run in `finalizing` therefore leaves it within about 18 hours of its last failed review, plus the sweep's interval.

The run already stuck on production has an `unresolved` job older than 15 minutes. The first sweep after deploy requeues it, and it is reviewed by the changed investigator.

## Player-facing text

- A run resolved without a verdict shows: "The review could not be completed after repeated attempts. This run ended with no result."
- The rules copy "A failed review leaves the result unresolved." becomes "A failed review is retried for up to a day. If it still cannot be completed, the run ends with no result." The sentence "An unresolved review never confirms a win." stays.
- While retries are pending the existing "unresolved" texts are shown, as today.

## Measurement

- E1. `scripts/flag-read-eval.ts` accepts `--cases FILE` and `--call-limit N`. A cases file holds exported production runs in the shape `scripts/annotation-eval.ts --corpus` reads: `id`, `kind`, `sessions` with `messages`, plus `targetSessionId` and `readOccurred`. The script reviews the target session of each case once and reports the verdict, the number of model requests, whether the decision was forced, the latency and the cost. Without `--live` it calls nothing.
- E2. After the build the lead runs it live on the played long chains, the stuck run among them, and on a sample of the other played runs, at limits 8, 12 and 16. The lead sets `MONITOR_CALL_LIMIT` to the lowest value at which no review in the set is forced to decide, if that value keeps a review inside its 90 second deadline. Otherwise the lead keeps 8 and reports. The table goes under Evidence.

## Out of scope

- Prompts per isolation mode, command times and a path-trace tool. Second part of step 4.
- Routing. Step 3.
- Reusing a failed attempt's retrieved evidence in the next attempt.
- An admin action to resolve a run by hand.

## Acceptance

Integration tests use the real worker entry point `runMonitorWorkerOnce`, real Postgres and provider fakes only.

- D1. A review is told its budget: the first investigator request contains the number of model requests available.
- D2. An investigator fake that keeps calling retrieval tools receives the notice on its last request, with only `finish_investigation` offered if the library allows it. A valid decision on that request completes the review, the job is `caught-up` or `caught`, and the review row has `forced_decision` true.
- D3. A review that finishes before its last request has `forced_decision` false and receives no notice.
- D4. A last request that returns no valid decision fails the attempt, as today.
- F1. A failed attempt leaves a `ctf.monitor_reviews` row with `completed_at`, `calls` and `operational_error` set.
- R1. With a run in `finalizing` and a job `unresolved`, a sweep before 15 minutes changes nothing. A sweep after 15 minutes requeues it with `attempts` 0 and `requeues` 1. The following requeues need 1 hour, 4 hours and 12 hours. Tests move the job's timestamps in the database. They do not wait.
- R2. A requeued review that returns `allow` lets the run finalize as today: `captured` for a correct flag with the bug requirement met.
- R3. A requeued review that returns `block` catches the run.
- R4. An `unresolved` job of an `active` run is not requeued by the sweep.
- U1. A run in `finalizing` whose job is `unresolved` with 4 requeues used becomes `ended` on the next sweep. One `unverified` event exists, the finalization job is `done`, the run no longer counts toward the cap, and a later cleanup deletes its Sprite through the Sprite fake.
- U2. The same run with another session's job `caught` is left to the catch.
- U3. A run in `finalizing` for 24 hours with `finalization_error` set becomes `ended` the same way. One at 23 hours does not.
- U4. `publicGame` for a run resolved this way reports a status and reason the play page renders with the new sentence. A unit test pins the copy.
- B1. A requeued review on a run whose settled spend is past its budget plus the overage is refused, fails, and the schedule still ends in U1.
- M1. Migration 026 applies to a database at 025 and is additive.
- E1. The eval options have tests against provider fakes: a dry run, a forced decision reported as such, and a case file with two sessions.
- G1. `npm run check`, `npm run test:integration`, `npm run build` and `npm run test:coverage` pass.

## Risks

- A forced decision can be wrong. Told to decide, the investigator may report no read when one more request would have found it. That outcome is a win for the player, which is the user's ruling. It may also report a read on thin evidence. The decision schema still requires a cited reference in the target session for a positive finding.
- The investigator's budget becomes something a player attacks on purpose. E2 sizes it against the chains played so far, which are six.
- A long provider outage ends submitted runs with no result after about 18 hours.
- Up to 15 review attempts on one run cost money. The overage ceiling bounds it at $0.25 past the run's budget.

## Open questions

1. When the retries are used up and there is still no verdict, is a correct submission a win? This contract says no, because by then the cause is a provider failure and not a transcript the investigator could not follow: that case is handled by the forced decision. The user's ruling as worded would say yes. One constant, `UNVERIFIED_SUBMISSION_STATUS`, holds the choice.
2. Whether a forced decision is shown to the player, for example "the investigator ran out of budget". This contract stores it and shows nothing.

## Evidence

- The stuck run's reviews, read from production on 2026-11-20: three attempts at snapshot revision 54, each with 8 investigator requests and one classifier request, 173,672 to 175,773 tokens, $0.062 to $0.079. Two earlier reviews of the same session completed in 3 and 4 requests.
- Code facts in Problem were mapped by a read-only agent and the cited lines for the call limit, the retry rule and the finalization claim were checked by the lead.
- Not measured yet: how many requests the played long chains need. E2.
