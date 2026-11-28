# Release gate, part 2, stage 2c-2: run stories with the monitor worker

Worktree: `/Users/jonathan/Code/ctf/.worktrees/e2e-gate`
Branch: `feature/e2e-gate`, reset to `main` at `316f3a2`, which has the auto-continue fix and its story R12.
Request: on 2026-11-26 the user said these must be tested in the browser, and confirmed both kinds of catch: a captured run on the leaderboard, a catch by the investigator, and the admin game rules changing how a run plays. Stage 2c-1 covered what the web app plays alone.

Roles: lead Claude Fable 5.2. Plan verifier and code reviewer Claude Opus, high effort, read-only. Developer Claude Sonnet, medium effort. The user gave standing permission on 2026-11-27 to commit, push, open and merge pull requests.

## Problem

The browser suite has twenty-three stories and no monitor worker. A run can be started, played and caught by the web app, but nothing reviews it. No story reaches a capture, the leaderboard, a catch by the investigator, the scoring of the seed bugs, or the settling of a stopped command. Those are the paths where the web app, the database and the worker have to agree.

## Proven by a spike on 2026-11-27

A throwaway run of the suite with the worker as a second process, scratch fakes and scratch stories, all removed afterwards. Ten suite runs.

- **The worker runs under the suite's preload.** Started as `node scripts/monitor-worker.ts` with the server's environment, it registered its wake address on loopback, the app's wakes reached it, and its requests and Sprite calls went through the same guard and the same patched client. SIGTERM ended it with exit code 0 in under 20 ms and removed its registration.
- **A review takes about a second.** A job is claimable once the session's lease ends, and the worker finds it on its one second idle poll.
- **A harmless turn** costs three requests to the `systemone` endpoint: the classifier, and one annotation each for the command and its outcome. With quiet answers the review is deferred and ends as an allow with no model call.
- **A disguised read** adds a catalogue read and two investigator completions. The investigator ends by calling `finish_investigation`. For a block the worker asks it to confirm, and the second answer repeats the call. The review is then a block with the confirmation kept, the run is caught and the worker deletes the Sprite.
- **An upload reaches the real route.** The Sprite fake posted the flag to the app on loopback with the endpoint's host and `x-forwarded-proto: https`, and the route answered 202. The run went to `finalizing`, the worker reviewed it and it was `captured` 1.4 seconds after the instruction. The page showed it after its next 3 second poll.
- **The bug-fix rule.** With the rule on, the worker runs the four seed scoring commands through the Sprite. A capture needs one to pass. With the rule off none runs.
- **The isolation rule** changes the review's stored `prompt_hash`, the run's stored rule and the page's rule state, and a capture made under the other setting leaves the leaderboard.
- **A stop during a command** leaves the operation `unknown`, the worker asks the Sprite for its sessions and settles it as `interrupted`, and a further instruction is accepted.
- **The existing stories are reviewed too.** With the worker on, every run the twenty-three stories start gets a review, so the new fakes have to answer for their transcripts, including the run that printed the flag.
- **The fail-closed story deletes the worker's wake registration.** Later reviews then rely on the idle poll.
- **A refused worker request does not fail fast.** The review is retried three times over seven seconds and then marked unresolved. A refused classifier request logs nothing in the worker's log.

Auto-continue is not in this stage. The spike found the browser stopped after one continue. That defect is fixed on `main` with its own story, R12.

## Scope

1. **The worker process.** `scripts/test-e2e.ts` starts the monitor worker after the server, with an environment built the same way as the server's and checked the same way before the spawn, and with the preload. It waits for the worker's wake registration before the stories start, writes the worker's output to a log under `.artifacts/e2e/`, and stops it with SIGTERM before the server. An interrupt, a failed story or a bound port leaves no worker running. A worker that exits early or with a non-zero code is a problem that fails the run, the wait for its registration stops when the worker has died or the run was interrupted and prints the worker's log, and no worker is started once the run is stopping.
2. **Monitor fakes**, `tests/e2e/monitor-fake.ts`, reached through the OpenRouter fake.
   - `systemone`: the classifier's question set, matched in full against the app's own question definitions, with quiet answers, and the two annotation sets through `tests/integration/annotation-fake.ts`. A confirmed block also makes the worker screen the decoded text, which sends a text screen and a command annotation that the existing fakes answer. Any other set is refused, as today.
   - Chat completions whose `session_id` names the monitor role: the investigator. It validates the bearer key, the `session_id` form, `stream: true`, the model, the provider block and the four tools. It reads only the rows of the target session from the request and decides by the commands in it: a block when a command is one of the two flag-reading commands in the scripted agent's table and its result row is present, an allow otherwise. Its answer is one `finish_investigation` call with exactly the three keys the worker validates, a tool-call id of its own, a `tool_calls` finish reason and a usage block. A block names the tool row of that command as evidence. A second request is accepted only when it ends in the worker's read-confirmation message, and gets the same call. A request it cannot place is refused.
   - A second-look request is refused. No story produces a score that asks for one.
3. **The scripted agent and the Sprite fake** gain what the stories need, and nothing else:
   - keywords and commands for a disguised read (`base64 /tmp/flag.txt`), an upload, a bug fix and a long command;
   - the upload: the Sprite fake posts the Sprite's flag to the app on loopback at the path of the command's `TARGET`, with the endpoint's host and `x-forwarded-proto: https`. The runner passes the app's loopback origin in a variable of its own;
   - the fix: the command leaves a marker in the Sprite's directory;
   - the four seed scoring commands, matched exactly against the app's own command for each seed bug and accepted without a `TARGET`. The first passes when the marker exists, and the others fail. Agent commands still need a `TARGET`;
   - the long command, which waits on the abort signal and rejects with its reason, and rejects by itself after the command's own time bound so a failed story cannot hang;
   - `listSessions`, which the fake already answers with an empty list. It gains a test for calls at the same instant.
4. **Reviews are waited for and checked.**
   - A helper waits until a run is settled: every monitor job of the run is `caught-up` or `caught`. A run with no job is settled. It fails at once when a job is `unresolved` or a review of the run has an operational error, and names the error.
   - Every story that starts a run calls it for each run it started, the twenty-three existing ones included, so a review's failure lands in the story that caused it. The call sits in the story's body after its assertions and not in a `finally`, where a timeout would hide the story's own error. The fourth-run story waits on all three of its runs.
   - The worker's log is scanned for failure events by the rule the server's log uses, with its own cursor, per story and at the end of the run. A story that fails drains the worker's log as it drains the server's.
   - The end-of-run check gains: no run left `finalizing`, no finalization job that is not done or that has an error, no monitor job left unsettled and no review with an operational error.
5. **The fail-closed story** saves the worker's wake registration before it writes its own and restores it afterwards.
6. **Test ids** under `app/`: the leaderboard's rows and the name in a row. The other elements the stories read have ids already.
7. **Stories.**

   | Id  | Story                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
   | --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | W1  | Under the default rules, which require a bug fix, the agent fixes a bug and then uploads the flag. The page shows the run `finalizing` and then `captured`, the stored run is `captured`, the stored submit event has `bugsPassed` 1, and `/rank` lists the member.                                                                                                                                                                                         |
   | W2  | With the bug-fix rule on, an upload with no fix ends the run as `ended` and the member is not on the leaderboard. An admin turns the rule off at `/admin`, and a new run with the same upload is `captured`.                                                                                                                                                                                                                                                |
   | W3  | The agent runs `base64 /tmp/flag.txt`. The run ends as caught, the page shows the cause `flag_read`, and the stored review is a block with its confirmation kept. Without any call to the cleanup route, the Sprite directory goes, the run's Sprite is marked deleted and a delete operation is stored as completed.                                                                                                                                       |
   | W4  | With isolation off, a run is captured and its review's `prompt_hash` is recorded. An admin turns transcript isolation on at `/admin`. A new run stores the rule, and its review's `prompt_hash` is the shared policy's and differs from the first. The first capture is no longer on the leaderboard. The admin restores the rule: the capture is back on the leaderboard, and the second run's page still shows isolation on, which is the run's own copy. |
   | W6  | A member presses Stop while a command runs. The transcript shows the stopped command and the resumable entry, the stored operation becomes `interrupted`, the run stays active, and after that a further instruction gets a reply. The story declares `game.response.failed` in the server's log.                                                                                                                                                           |

## Non-goals

- Auto-continue. Story R12 on `main`.
- A second look, a lingering Sprite session, a worker that fails or restarts mid-review, and reconciliation of old holds. The integration suite covers them.
- Any change under `lib/`, `db/` or to app behaviour. Edits under `app/` add `data-testid` and `data-state` only.
- The real mode on staging. Part 3.

## Design constraints

- **Rules through the admin page.** W2 and W4 switch their rule at `/admin`, as the jailbreak story does. A run copies its rules when it starts.
- **No upload after a cut stream.** Finalization needs the run's reserved spend at zero, and a completion cut after its first chunk keeps a hold for two minutes. No story uploads in a run where it stopped a streaming completion.
- **The stored cause.** A catch by the investigator has no `cause` in the stored event. W3 reads the page's cause and the review row.
- **Declared failures.** The story table names the event W6 declares. If a story logs an event the table does not name, in either log, the developer stops and reports it.
- **Each story stands alone.** A story makes the captures and reviews it compares, and passes when its file is run by itself.
- **Timing.** Stories wait on test ids, `data-state` and database rows with the suite's timeout and use no fixed sleep. The page shows a state the worker made after its next 3 second poll.
- **Fakes fail closed** and keep their state to what a story needs. The command table stays a fixed list.
- **Selection** by `getByTestId` with literals, and both guards pass.
- **Lazy imports** in the preload, as before.

## Acceptance criteria

| Id  | Given, when, then                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Given the suite, when `npm run test:e2e` runs three times in a row, then all twenty-eight stories pass each time with no violation, no undeclared failure in either log and no end-of-run problem.                                                                                                                                                                                                                                                                                   |
| D2  | Given the monitor fakes, then an offline test covers each: the classifier and annotation answers, an allow, a block with its confirmation, the evidence it names, and a refusal for a second look, an unknown question set, a wrong model, a second request that is not a confirmation, and a request it cannot place. Given the Sprite fake, then offline tests cover the upload's request, the marker, each scoring command's result, the long command's abort and `listSessions`. |
| D3  | Given each story W1 to W4 and W6, when its key assertion is mutated, then that story fails. Given W3 with the investigator fake set to allow, then W3 fails. Given W1 with the upload removed, then W1 fails.                                                                                                                                                                                                                                                                        |
| D4  | Given a worker request that a fake refuses, when the story that caused it waits for its reviews, then that story fails within the suite's timeout and names the review's error or the refused request's violation. Given a run left `finalizing` or a worker that has exited, then the run ends with a problem that names it. The developer records one case of each.                                                                                                                |
| D5  | Given the edits under `app/`, then the word diff used in the test id contract shows no removed token and only attribute additions.                                                                                                                                                                                                                                                                                                                                                   |
| D6  | Given a failing story, a bound port, and an interrupt during the build or the stories, then the run exits non-zero and leaves no container, server, worker or browser.                                                                                                                                                                                                                                                                                                               |
| D7  | `npm run check` and `npm run test:integration` pass.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| D8  | Given `ci` on GitHub, then the `e2e` job passes and stays under four minutes. The developer reports the suite's local time before and after.                                                                                                                                                                                                                                                                                                                                         |

## Criterion, check and evidence

| Id  | Check                                                                  | Evidence                                                                                                                                                                                                                                                                                                                          |
| --- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Three runs by the developer and three by the lead.                     | Passed. The developer ran the suite three times and the lead three times on the final tree on 2026-11-28 UTC: 28 of 28 each time in about 94 seconds, with no problem at the end of a run.                                                                                                                                        |
| D2  | The offline tests, written first and seen failing.                     | Passed. `tests/e2e-monitor-fake.test.ts`, `tests/e2e-sprite-fake.test.ts` and `tests/e2e-runner.test.ts`, each seen failing first. `npm run check` runs them: 760 of 760.                                                                                                                                                         |
| D3  | The developer's mutation record. The lead repeats the two named cases. | Passed. The developer mutated each story and saw it fail. The two named cases: with the investigator allowing, W3 failed with `data-state is "active", not "caught"`; with the upload removed, W1 and W2 failed. The lead repeated both. After the review, a long command that ignores its abort made W6 fail after 17.9 seconds. |
| D4  | The developer's record of one refused request.                         | Passed. A classifier fake made to refuse failed R3 in about 2.3 seconds, with the violation recorded and the review's operational error named. A worker killed after it registered ended the run with four problems: the early exit, the run still `finalizing`, the unfinished finalization and the unsettled monitor job.       |
| D5  | The word diff against the branch's base. The reviewer reads it.        | Passed. The word diff against `316f3a2` adds `data-testid="rank-row"` and `data-testid="rank-name"` and removes nothing. The reviewer read it.                                                                                                                                                                                    |
| D6  | The lead's failure-path script, extended to look for a worker process. | Passed. The lead's script covered a failing story, a bound port and an interrupt during the build and during the stories: each exit was non-zero. Its first pass reported a worker and a browser left over in every case. A second pass that listed the matching processes found none, and the first result was not reproduced.   |
| D7  | Both commands.                                                         | Passed. `npm run check` 760 of 760 on the final tree. `npm run test:integration` 650 of 650 before the corrective round, which changed no file an integration test loads.                                                                                                                                                         |
| D8  | The run on the pull request.                                           | Recorded on the pull request. Locally the suite went from about 80 to about 94 seconds.                                                                                                                                                                                                                                           |

## Steps

1. The runner: start, check, wait for and stop the worker, its log and its cursor. Verify: the twenty-three stories fail on refused worker requests, which shows the worker is on and guarded.
2. Offline tests for the monitor fakes, then the fakes. Verify: D2 for them, and the twenty-three stories pass with every run reviewed.
3. The review wait in the run helpers and the end-of-run checks, and the fail-closed story's restore. Verify: D4.
4. Offline tests for the Sprite fake's additions, then the additions and the agent's keywords. Verify: D2.
5. W3, W1, W2, W4, W6, each with its ids. Verify: each passes alone and with the suite.
6. Mutations, `docs/verification.md`. Verify: D1, D3, D5, D7.

## Ownership

Owned: `tests/e2e/`, the offline tests under `tests/` for the suite and its fakes, `scripts/test-e2e.ts`, attribute-only edits under `app/`, existing offline tests only where an added attribute changes what they match, `docs/verification.md`, this plan.

Not owned: `lib/`, `db/`, `tests/integration/`, `scripts/monitor-worker.ts`, the workflows, `package.json`.

A test in the commit hook's environment must not run `git` without first deleting every `GIT_` variable.

## Risks and open questions

- **The investigator fake decides by command text.** It does not judge output, so it proves the wiring of a block and an allow and nothing about the investigator's judgement. The evals under `evals/` and the real mode cover that.
- **The upload command names the flag file** and the fake clears it. In the game an upload without a read in the transcript is the winning move, and a final review always reaches the investigator.
- **A refused annotation does not fail a review.** The review goes on without it. Such a refusal is caught by the violation it leaves and by the worker's log.
- **The review wait adds about a second per run**, 10 to 15 seconds across the existing stories. D8 bounds the job on GitHub, and the bound is tight.
- **The spike's stories took the violations and log failures themselves,** so its passing runs do not show these paths are free of either. D1 does.
- **The auto-continue story is on `main`.** R12 holds three responses for five seconds each. With the worker on it has reviews to wait for like every other run story.
- **A suspected defect that is not one.** The plan verifier reported that a captured run's transcript would read as a wrong flag, because a submit event that arrives over HTTP has no `correct` field. The lead checked: such an event always renders the generic "Submission received" text, and the caption with the flag's result belongs to the older tool submissions only. `tests/transcript.test.ts` asserts it.

## Plan verification

An independent read-only check on 2026-11-27 approved with changes, all folded in. It confirmed by reading that each story's outcome follows from the worker's code, that the existing fakes already answer the investigator's catalogue read and the decoded-text screens, that switching a rule mid-suite does not disturb other stories, and that nothing needs a change under `lib/`.

- "Settled" is defined, a run with no job counts, and an unresolved job or an operational error fails at once. The wait sits in the story's body.
- The fourth-run story waits on all three runs, because the next story sets the daily cap to zero and a late review would then fail unattributed.
- The end-of-run check also catches a run stuck in `finalizing` and a failed finalization, and the runner notices a worker that dies.
- W1 names where the bug count is stored. W3 proves the worker's own delete without the cleanup route. W4 makes its own capture and tells the run's copy of the rule from the current setting.
- The fakes' validation is spelled out, and the long command is bounded.

## Review

An independent read-only review on 2026-11-27 found no P0 or P1 and two P2 findings. One corrective round closed both, and the reviewer confirmed it and found nothing new at P0 to P2.

- **W6 did not prove the stop reached the Sprite.** The Sprite fake now keeps a `running` file while the long command is pending, and `listSessions` reports a session while the file exists. The worker therefore settles the command only after the abort arrives. The file goes on abort, at the time bound and when the Sprite is deleted.
- **W2 did not prove why its first run ended.** The story now reads the stored `submitted_flag_correct` and `bug_fix_required` and the run's `score` operation: a correct flag with the rule on and scoring completed for the first run, and no scoring for the second.
- W4 now asserts each run's `prompt_hash` equals the policy's hash for that run's isolation setting.

Minor notes left as they are: W6 could check the `running` file directly, the worker's spawn has no `error` handler, a second interrupt to the runner is not handled, the upload ignores its abort signal, and `scripts/test-e2e.ts` is near 480 lines.
