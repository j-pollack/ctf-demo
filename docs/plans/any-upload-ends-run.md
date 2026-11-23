# Any upload of a flag ends the run and is graded

- Worktree: `/Users/jonathan/Code/ctf/.worktrees/monitor-routing`, branch `feature/monitor-routing`. Ships in pull request 37.
- Status: verified by the plan verifier on 2026-11-22. Two blocking findings folded in.

## The user's ruling

2026-11-22, in chat: "If anything, ever manages to hit the right endpoint with a flag submission it should automatically end the run and get graded."

This replaces the lead's rule of 2026-11-18 (`docs/plans/text-screening.md`, A0 and R6a) that a command's upload authority ends when that command returns. It applies while the run is active. A run that has ended, been caught or been submitted takes no new upload, as today.

## Problem

`receiveFlagSubmission` in `lib/flag-submissions.ts` accepts an upload only when all of these hold. Otherwise it answers `stale` (HTTP 409):

- the run is `active`, in async mode, with HTTP submission;
- the command that received the token has status `running`, and the upload arrived before its `returned_at`;
- the command's generation is the run's;
- the command's session still holds the lease the command started under, the lease has not expired, and no stop was requested.

So an upload from a background process that outlives its command, from a command that was stopped, or from a later response of the same command's script, is refused. The user's run `1ef3b39a` hit this: a background `curl` of the flag got 409.

Once a receipt exists, these gates already stop play and keep working: command dispatch (`lib/monitor-commands.ts:108-113`), session create and claim (`lib/sessions.ts`), agent and screen inference (`lib/games.ts`), `catchJailbreak` (`lib/async-finalization.ts`), the runner's heartbeat and its receipt read after a command completes (`lib/runner-async.ts`), and the finalization claim, which also requires every session's final review (`lib/async-finalization.ts:249-297`).

A receipt that is accepted is scored only by `promoteHttpSubmission`, and only when its command is `completed` with output and no command on the sprite is `running` or `unknown`. `promoteHttpSubmission` is called when a command completes and when the worker settles a stopped command (`docs/plans/stopped-command-settle.md`). An upload that arrives when no command runs would never be promoted.

## Design

1. `receiveFlagSubmission` accepts an upload when the token names a command of a run that is `active`, in async mode, with HTTP submission. The body rules, the token format, the hash and the one-receipt rule stay. The checks on the command's status, its return time, its generation, the session lease and the stop request are removed, with the session and operation row locks and the arrival-time read that served them. The flow is: look up the token, lock the run, check for a receipt, check the run, insert, promote.
2. In the same transaction, after inserting the receipt, it calls `promoteHttpSubmission(client, gameId)` and reports whether the run was promoted.
3. `promoteHttpSubmission` keeps its run check and its wait while any command on the sprite is `running` or `unknown`. It drops its test of the receipt command's status and output: a receipt's command is on the run's sprite, so when nothing there is `running` or `unknown` it is `completed` or `interrupted`.
4. The upload route (`app/v1/end/[[...token]]/route.ts`) awaits `wakeWorker()` after the transaction commits when the run was promoted, as `app/api/cleanup/route.ts` does, so the worker grades it without waiting for its next scheduled pass. The un-awaited wake inside `promoteHttpSubmission` stays for its other callers.
5. Promotion moves the run to `finalizing` and bumps its generation, which ends any response still running. Every session then gets its final review.
6. `startGame` does not end a run that has a receipt. It refuses the new run with "Your last run is being graded. Start a new run in a minute." (HTTP 409) until that run leaves `active`. A receipt that waits only on a stopped command is settled by the worker within seconds.
   6a. A new run is also not refused for a receipt that nothing can promote: when a command is left `running` with no live session lease, `startGame` replaces the run as before, so the owner is not locked out until the 24-hour sweep.
   6b. An inference that ends before the provider gave a generation id is settled at its ceiling, estimated, at once, with one `inference.settled_without_generation` log line. `reconcileInference` can only find a hold that has an id, so without this the promoted run would wait for the 24-hour expiry. A request that has an id keeps the reconcile path.
   6c. The rule in 6b covers every role and every error: a monitor request that stalls before headers or fails before any generation id is charged its ceiling the same way, and so is a Jev classifier request that fails after dispatch (`lib/monitor-classifier.ts`, which has no generation id at all). The only other outcome for such a hold is the same ceiling charge after 24 hours, and until then it blocks `claimAsyncFinalization`. User decision, 2026-11-23: a hold that can never be reconciled is charged at once rather than left open for the expiry.
   6d. Consequences of 6c. Failed monitor requests now count against the monitor's allowances at once; before, they stayed invisible until the expiry. The classifier charges every failure after dispatch, including Typesafe 400 and 429 responses, by the user's every-error decision. The charge is skipped if the settle itself fails: the original error is kept, `inference.settle_failed` is logged, and the hold falls back to the 24-hour expiry.
7. `markCommandReturned` stays, because the investigator reads `returned_at` as evidence. The rule in the runner that skips the output screen when that stamp fails had no purpose but the upload window and is removed.
8. Comments and plans that state the old window are updated: `lib/flag-submissions.ts` (the doc comment of `promoteHttpSubmission`), `lib/runner-async.ts` (the note on upload authority), `lib/monitor-commands.ts`, `docs/plans/stopped-command-settle.md` (design 7 and its open question) and `docs/plans/text-screening.md` (R6a).

## Decisions by the lead, open to the user

1. **The upload is graded under the command whose token it used.** A background process inherits the token of the command that started it. That command is the one the final review looks at for the read.
2. **A running or unknown command still holds the grade back.** A running command's output may hold the flag, and the flag-output catch must get its chance before the run is graded. A command under `timeout -k 2 15` ends within 17 seconds, and a stopped one is settled within seconds. A command left `running` by a runner that died is not settled by anything. That gap is older than this change.
3. **One receipt per run stays.** The first valid upload is the run's submission. A second upload with a different body is a conflict, including while the first waits on a running command.
4. **A new run waits for the last one's grade** (design 6). Ending a run with a receipt would discard an upload the user ruled must be graded.

## Safety

- The final review of every session still runs before any win. A late upload makes no read invisible: the command that read the flag, or started the process that did, is in a session's transcript.
- An upload from a stopped command is graded on its body. Its output was never observed, which does not matter for the grade: the grade checks the uploaded value against the flag's hash.
- An upload needs a token issued by this run. The token is not hidden: a command that prints `$TARGET` puts it in the transcript, and under this rule it stays valid while the run is active. Anyone holding it, the player included, can upload from outside the sandbox. They still need the flag's value, and the read that got it is in a session the final review sees. Open to the user: see below.

## Open question for the user

- Uploads from outside the sandbox. With the window gone, a printed upload address works from anywhere until the run ends. The lead recommends accepting this, as the ruling says "anything": the flag's value is the secret, and every session's final review still decides the run. Limiting uploads to the sandbox has no reliable signal, because Sprites' outbound address is not fixed and the address can be re-encoded to dodge redaction. `docs/plans/flag-vercel-rollout.md` describes the token as bound to the command's lease, which stops being true.

## Open follow-up

A worker or runner process that dies mid-request never runs its `finally`, so a hold without a generation id still waits for the 24-hour expiry. A sweep of such holds older than the longest request could close it.

## Out of scope

- The tool transport (`submit` tool) runs. They have no upload address.
- Telling the player on the page that a background upload ended the run. The receipt event already says the flag was submitted.

## Acceptance

Integration tests use real Postgres, the real runner and the existing Sprites fake.

- U1. An upload that arrives after its command returned, with no response running, is accepted. The run moves to `finalizing` in the same request, the route sends a wake to the worker, and the final reviews run. A correct flag with no catch wins.
- U2. An upload that arrives after its session's lease expired or was released is accepted and graded.
- U3. An upload from a command that was stopped is accepted. The run is graded once the worker settles that command. An upload after the stopped command was already settled is promoted at once.
- U4. An upload that arrives while another command is running is accepted and promoted when that command completes. If that command's output holds the flag, the flag-output catch ends the run and the receipt stays unpromoted.
- U5. An upload after the run is `caught`, `ended` or `finalizing` is refused as before. A second upload with a different body is a conflict, also while the first waits.
- U6. A wrong flag uploaded late ends the run as a wrong submission.
- U7. An upload while another session is mid-inference: that session's response stops, no error event is persisted for it, its lease is released, and the finalization claim takes the run.
- U8. An upload racing a jailbreak catch, in both orders: the run ends one way only, and a refused instruction never reaches the agent.
- U9. `startGame` with a previous run holding a receipt refuses with 409 and the message of design 6, and does not end that run.
- U10. An upload with a token printed into the transcript, from outside any command, is accepted while the run is active. This documents the open question.
- U11. Existing tests that asserted `stale` for a late upload are changed to the new rule and renamed where their names state the old rule. The plan verifier listed them: in `tests/integration/flag-submission.test.ts` the receipt-binding test, in `tests/integration/flag-submission-route.test.ts` the bounded-capability test, and in `tests/integration/flag-submission-lifecycle.test.ts` the screen-in-flight test, the lost-race test and S7. The build report names each.

### Every build

`npm run check`, `npm run test:integration`, `npm run build` and `npm run test:coverage` pass, run by the lead from raw output.

## Live check after the build

On the preview: start a background process that uploads the flag after its command returns, as in run `1ef3b39a`. The upload is accepted, the run goes to `finalizing` without another instruction, and the final reviews decide it.

## Evidence from the plan verifier

- Blocking, folded in: the wake inside `promoteHttpSubmission` is not awaited, and the upload route returns at once, so an idle worker could sleep up to 6 hours before grading (design 4, U1). The safety claim that only the run's commands can upload was false, because a printed token works from anywhere (Safety, open question, U10).
- Non-blocking, folded in: the receipt gates that keep working, decision 3's wording, decision 2's real reason, `startGame` discarding a pending upload (design 6, U9), noise from a session mid-inference (U7), stale comments and plans (design 8), the simpler flow (design 1 and 3), and the tests that flip (U11).
- Confirmed: one sprite per run, the generation check changes nothing for an active run, a token names only its own run, no lock cycle with any writer, a failed promotion rolls back the receipt, every win still needs every session's final review, and `interrupted` is safe as a scored receipt's command status.

## Evidence from the code review

- Blocking, folded in: an inference aborted before any generation id left a hold that only the 24-hour sweep released, so a promoted run waited for it (design 6b, U7 now drives the worker with no manual settle and asserts the hold is settled estimated at its ceiling).
- Should fix, folded in: `startGame` could lock an owner out for 24 hours behind a receipt that nothing can promote (design 6a, U9 second test). U1 passed with `queueFinalReviews` removed, so it now finishes the ordinary reviews first and asserts the promotion queues the final ones.
- Minor, folded in: stale lock comment, the `receiveFlagSubmission` wrapper, the supersession notes in `flag-http-submission.md` and `text-screening.md`, and the 10-second timer in U7.
