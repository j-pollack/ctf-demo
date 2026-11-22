# A stopped command is confirmed dead and settled

- Worktree: `/Users/jonathan/Code/ctf/.worktrees/monitor-routing`, branch `feature/monitor-routing`. Ships in pull request 37.
- Status: built, reviewed and checked live on the preview on 2026-11-22.

## Problem

Pressing Stop while a command runs aborts the command's exec. The runner records the command's operation in `ctf.sprite_operations` with status `unknown`, because it cannot tell whether the command is still running in the sandbox. The same happens when `executeCommand` throws for any other reason, such as a network failure to Sprites.

Nothing settles an `unknown` command operation until the run's sandbox is deleted. Until then:

- `promoteHttpSubmission` (`lib/flag-submissions.ts`) returns `pending` while any operation on the sprite is `running` or `unknown`, so a correct flag upload is never scored.
- `claimAsyncFinalization` and the final checks in `lib/async-finalization.ts` skip the run for the same reason.
- `getGameView` (`lib/games.ts`) reports the monitor as `unresolved` ("Review could not be completed") because of `uncertain_command`.

So one press of Stop during a command makes the run unwinnable, and the player is not told. The user's ruling of 2026-11-22: pressing Stop must not end the run, and the run must stay winnable.

The rule behind `unknown` stays: no win is granted while a command may still be acting in the sandbox.

## Evidence

A live probe on 2026-11-22 on a throwaway sandbox, `/tmp/sprite-stop-probe.mts`, ran each command the way `executeCommand` does (`timeout -k 2 15 bash -lc`, `maxRunAfterDisconnect: "1s"`) and aborted it after 3 seconds.

- Before the abort, `sprite.listSessions()` listed one active session, and `ps` showed `timeout`, `bash` and `sleep` in one process group.
- 0.3 seconds after the abort, `listSessions()` returned no session and `ps` showed no process. That held for `sleep 30` and for `(sleep 45; echo bg) & sleep 30`, whose background child was killed with the group.
- It held at every check up to 27 seconds later.

Every command also runs under `timeout -k 2 15`, so its process group is killed 17 seconds after it starts at the latest. A process that leaves the group, for example with `setsid`, survives both. That is also true of a command that completes normally, which is not `unknown`, so it is not a reason to keep a stopped command unsettled.

## Design

1. A new worker step, `settleStoppedCommands`, runs in `finalizeOneRun` of `lib/monitor-worker.ts`, before `claimAsyncFinalization`, so a run already in `finalizing` can be claimed in the same pass. It has its own try and catch that logs `monitor.settle.failed` with the sprite name and the error, and never stops the rest of the pass.
2. It selects sprites that have a command operation with status `unknown`, whose sandbox is not deleted and that have no `delete` operation in `running` or `unknown`. It checks every such sprite in the same pass, all at once, so a failing or slow sprite blocks no other and a pass waits at most one `listSessions` timeout. A sprite whose last check failed or showed a session is skipped for 10 seconds, tracked in worker-process memory shared by its loops. For each sprite it records the ids of those `unknown` command operations before it calls Sprites.
3. It then calls `listSessions()` on the sprite through a new function in `lib/sprites.ts`.
   - If the list is empty, the sprite has no exec session, live or lingering. The step settles the operations whose ids it recorded in step 2. An operation that became `unknown` after step 2 is left for a later pass.
   - If the list has any session, whatever its `isActive` flag, nothing on that sprite is settled. A live command from another session of the run ends within 17 seconds, so a later pass settles.
   - If the list call fails, nothing on that sprite is settled. The other sprites of the pass go ahead.
4. The settle is one transaction with the lock order of `deleteSpriteIfEligible`: `lockSprite`, then the rows in `ctf.games` of the affected runs `FOR UPDATE` in id order, then the operations. It sets status `interrupted` and `completed_at` on each recorded operation that is still `unknown`. Output and tool events stay as the runner wrote them. It bumps `state_revision` on each affected run so open pages refresh.
5. In the same transaction it calls `promoteHttpSubmission(client, gameId)` for each affected run. A receipt that was waiting only on the stopped command is promoted and scored, as it would have been had the command finished.
6. `hasPendingWork` in `lib/monitor-jobs.ts` also counts the same operations the settle selects (`unknown` command operations on sprites that are not deleted and have no open `delete`), so the worker stays awake until they are settled.
7. Nothing else changes about an interrupted command. Its output was never observed, so:
   - an upload it made stays unscored, because `promoteHttpSubmission` scores only a receipt from a `completed` command with output, and `receiveFlagSubmission` refuses any later upload from an operation that is not `running`;
   - the investigator still reviews its command text, with the output the runner recorded.
8. `scripts/smoke.ts` gains a `listSessions` check on its live sandbox: one session while a command runs, none after it is aborted. It pairs the new fake with the real service. It is run live only with the user's go-ahead.

## Decisions by the lead, open to the user

1. **The check is "the sprite has no exec session at all", not a match on the stopped command.** Sprites does not return the exec's session id to `execFile`, and a session's `command` field shows only part of the command. Waiting for the sprite to be idle is conservative: at worst a settle waits for another session's command to finish.
2. **No kill call.** The probe showed the abort already kills the group. If a session stays listed, the step waits for `timeout -k 2 15` to end it.
3. **The sandbox check, not a timer.** The plan verifier proposed settling any `unknown` command older than about 30 seconds, with no Sprites call, because every command is killed by `timeout -k 2 15`. That is less code. The user approved confirming in the sandbox on 2026-11-22, and the check also covers a sandbox that pauses mid-command, which a timer would not.

## Open question for the user

- A receipt from a command that is then stopped stays unscored, and the run allows one receipt (`ctf.flag_submissions` is keyed by run). Such a run can never be scored or end on its own. It needs an upload accepted while the command runs and then a Stop before the command returns. This contract leaves it as it is.

## Out of scope

- Telling the player on the page that a command was stopped. The tool output already says "The command could not finish in this run's environment."
- `unknown` operations of kind `score` or `delete`. They have their own handling.
- A command operation left `running` because its runner process died. It blocks the same paths. The same check could settle it once its session's lease has expired, in a later change.

## Acceptance

Unit tests stay free of the database and network. Integration tests use real Postgres and the existing Sprites fake, extended with `listSessions`, which fails on any call it was not set up for.

- S1. An `unknown` command on a sprite with an empty session list is settled to `interrupted` in one pass. A correct flag upload made after that by a completed command is promoted and scored.
- S2. A receipt that is pending only because of an `unknown` command is promoted and scored by the settle, in the same pass. This is the usual order: Stop, then the player resumes and uploads.
- S3. A listed session blocks the settle, with `isActive` true and with it false. When the list is later empty, the next pass settles.
- S4. A failing list call settles nothing on that sprite, logs `monitor.settle.failed`, and another sprite in the same pass is still settled.
- S5. An operation that turns `unknown` while the list call is in flight is not settled by that pass.
- S6. An operation that stopped being `unknown` before the settle, a sprite whose sandbox is deleted, and a sprite with an open `delete` operation are left alone, with no Sprites call for the last two.
- S7. A receipt from a command that is then settled stays unpromoted, and a later upload from that command's token is refused as stale.
- S8. Two runs on one sprite are both bumped and both promoted.
- S9. Two concurrent passes over the same sprite settle each operation once and leave consistent state.
- S10. A tool-transport run in `finalizing` with an `unknown` command is claimed for finalization in the same pass that settles it.
- S11. The run view no longer reports the monitor as `unresolved` once its only `unknown` command is settled.
- S12. Every candidate sprite is checked in one pass, and a failing sprite does not block the others.
- S13. `hasPendingWork` is true while an `unknown` command operation exists on a sprite that is not deleted and has no open `delete`, and false after it is settled.
- S14. A sprite whose check just failed is not listed again within 10 seconds, and is checked again after.
- Existing integration tests that seed an `unknown` command and run a worker pass get an explicit `listSessions` stub. The fake fails on a call it was not set up for.

### Every build

`npm run check`, `npm run test:integration`, `npm run build` and `npm run test:coverage` pass, run by the lead from raw output.

## Live check after the build

On the preview: start a run, press Stop during `sleep 60`, wait for one worker pass, and confirm the operation is `interrupted`, the run details no longer show "Review could not be completed. The result remains unconfirmed.", and a later upload of the flag from a completed command is scored.

## Evidence from the plan verifier

- Blocking, folded in: settling never re-ran promotion, so a receipt pending on the stopped command stayed stuck (design 5, S2). A dispatch-time cut-off was unsafe, because `started_at` is the dispatch transaction's time and the exec starts after it commits (design 2 and 3, S5). The settle's lock order could deadlock with `receiveFlagSubmission`, and one failing sprite could starve the others (design 2 and 4, S4, S6).
- Non-blocking, folded in: the worker could sleep with work left (design 6, S13), the step must run before the finalization claim (design 1, S10), concurrent passes (S9), existing tests need a `listSessions` stub, a live check of the new boundary in `scripts/smoke.ts` (design 8), and the run view's exact wording.
- Confirmed: the blocking paths, `interrupted` as the target status with no migration, that no late runner write can overwrite a settled operation, and that score and delete cannot overlap a settle.

## Live check on the preview, 2026-11-22

- Run `279ad878`: a command stopped before this change was settled at 23:11:29 UTC, on the worker's first pass after deploy. A second stopped command had sent `sleep 60` to the background with `disown`. It stayed `unknown` while Sprites listed its session and was settled at 23:13:27.8, when that `sleep` ended.
- Run `31a71959`: Stop during a foreground `sleep 60` at 23:27:43. The command was `interrupted` within 12 seconds, and the run details showed "Reviewed, nothing found". A later `curl --data-binary @/tmp/flag.txt "$TARGET"` was accepted at 23:28:14.7 and promoted as correct at 23:28:15.9. The final review then caught the read.
- The first upload attempt in `279ad878` failed for an unrelated reason: a preview run's upload address was the per-deployment host, and the sandbox only allows the host the run started with, so every push broke uploads for open preview runs. Fixed in `bc1979d`: a preview now uses its branch host.
