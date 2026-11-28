# Auto-continue stops after one turn

Worktree: `/Users/jonathan/Code/ctf/.worktrees/auto-continue-chain`
Branch: `fix/auto-continue-chain`, from `main` at `1f95535`. Clean tree.
Request: the release gate's browser stories were to cover auto-continue. A spike for that story on 2026-11-27 found the feature does not work past one turn. The user gave standing permission that day to commit, push, open and merge pull requests.

Roles: lead Claude Fable 5.2. Plan verifier and code reviewer Claude Opus, high effort, read-only. Developer Claude Sonnet, medium effort.

## Problem

When a response reaches the server's time limit, the stored event is marked to continue and the browser sends "Continue." by itself, up to the admin's number of auto-continue turns, which defaults to 8.

In the spike, with the response time limit at 5 seconds and a completion that never ends, the browser sent exactly one "Continue." and then stopped. It did so three runs out of three, with the turn limit at 2 and at 3. Afterwards the instruction field held the text "Continue.".

The cause, read from `app/game-ui.tsx` and seen in the request trace:

1. When a response's stream ends, the `finally` of `send` starts `refreshGame`, which reads the run.
2. The auto-continue effect then calls `send` with "Continue.", which records a pending instruction and posts it. The trace shows the read one millisecond before the post.
3. The read's answer was produced before the server saw the post. It is not busy and holds no user event after the pending instruction's `afterId`.
4. `reconcile` passes it to `instructionStatus`, which returns `rejected` for a run that is not busy and shows no matching event.
5. `reconcile` puts the text back in the draft, and a draft that is not empty stops the chain.

The instruction was in fact accepted: the server ran it. A member who sends an instruction by hand within the same instant can hit the same race and see their text return to the field while the agent answers it.

With the browser's reads of the run delayed by 400 ms, the same spike saw exactly three continues for a limit of three, which fits this cause.

## A regression

The plan verifier traced the defect to commit `2681c0c`, pull request 23. Before it, `send` advanced a counter, `submissionGeneration`, each time an instruction was sent. `refreshGame` still records that counter when it requests a snapshot and drops the snapshot when the counter has moved on. Since pull request 23 the counter advances only when the account changes, so the guard never fires for a send. `tests/instruction.test.ts` still describes the guard: "a delayed same-run snapshot cannot reject or erase a newer optimistic submission".

The stale snapshot does a second harm. It marks the session idle while the continued response is still running, so the composer shows idle and the Stop button is hidden until that response ends.

The first continue is always sent, because the effect runs before the read returns. The read then rejects it, and the restored draft blocks the second. A member's first instruction is safe: no read from an ended response is in flight. A member who types and sends within the round trip of that read can hit it, which is a narrow window because the field is disabled while a response runs.

## Scope

1. **The fix.** `send` advances `submissionGeneration` where it records the pending instruction. A snapshot requested before the send then no longer settles the pending instruction or replaces the run's state: the check `refreshGame` already makes skips both. Its events are still merged into the session, which only adds. No new marker and no new field.
2. **A browser story** that plays the chain and is seen failing before the fix.
3. **The scripted agent** in `tests/e2e/` answers a last user message that is exactly "Continue." with the reply of the last earlier user message that carried a keyword, and refuses it when there is none. The literal lives in `tests/e2e/agent-script.ts`.

## Non-goals

- The server's side of auto-continue, the turn limit, the response time limit and the copy.
- Whether a stalled stream should auto-continue. The user decided on 2026-11-26 to leave that as it is.
- The monitor worker and the stories that need it.
- A change to `instructionStatus`. The function is right, and its existing tests stay.

## Acceptance criteria

| Id  | Given, when, then                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N1  | Given the response time limit at 5 seconds, two auto-continue turns and a held completion, when a member sends one instruction, then the browser sends "Continue." twice and not a third time. The transcript ends with three stopped entries in their resumable state and three user entries, the instruction field is empty, the composer is idle and the run is active. The stored session holds three user events. |
| N2  | Given the same story, while each continued response runs, then the composer is in its busy state.                                                                                                                                                                                                                                                                                                                      |
| N3  | Given the same story on `main` without the fix, then it fails: the instruction field holds "Continue." after the second stopped entry, and no third response follows.                                                                                                                                                                                                                                                  |
| N4  | Given a request to the scripted agent whose last user message is "Continue.", then it replies as for the last earlier user message with a keyword. Given no such message, then it refuses.                                                                                                                                                                                                                             |
| N5  | `npm run check`, `npm run test:integration` and `npm run test:e2e` pass. The suite's twenty-two existing stories are unchanged and still pass.                                                                                                                                                                                                                                                                         |

## Criterion, check and evidence

| Id     | Check                                                                                   | Evidence                                                                                                                                                                                                                                                                      |
| ------ | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N1, N2 | The new story, three runs in a row by the developer and by the lead.                    | `tests/e2e/run-continue.test.ts`, story R12, about 19 seconds. Developer: three runs, 23 of 23. Lead on 2026-11-27: eight runs, 23 of 23, about 58 seconds wall each.                                                                                                         |
| N3     | The story run before the fix, by the developer, and with the fix reverted, by the lead. | Before the fix the developer saw R12 fail on the field holding "Continue.". With the fix line removed the lead saw it fail the same way, and after the review's stricter check, on "the composer went idle during a continued response". The other twenty-two stories passed. |
| N4     | An offline test of the fake, written first.                                             | `tests/e2e-openrouter-fake.test.ts`, two tests, which failed before the rule existed.                                                                                                                                                                                         |
| N5     | The three commands.                                                                     | `npm run check` 716 of 716 by the lead. `npm run test:integration` 650 of 650 by the developer. `npm run test:e2e` as above.                                                                                                                                                  |

No offline test can fail for this defect. The pure functions are correct and the fault is in the component's wiring, which only a browser exercises. The story is the regression test.

## The story

- The settings are stored before the page that reads them loads, which is before the member opens `/play`, and removed in a `finally`: `response_seconds` 5 and `auto_continue_turns` 2.
- The member sends the hold keyword.
- The story waits for each stopped entry in turn, each within the suite's 15 second timeout. One wait cannot span three responses.
- From each continue until its stopped entry shows, it reads the composer and fails if it is ever idle.
- As soon as the second stopped entry shows, it asserts the instruction field is empty. On `main` the field holds "Continue." at that point.
- After the third stopped entry it waits for the composer to be idle, then for one more read of the run, and then checks the six entries in order. A third continue would be sent in the render that shows the composer idle, so it would be an entry by then.
- It reads the run's user events from the database: the instruction and "Continue." twice.
- It declares the failures each timed-out response logs, in order: `inference.failed` then `game.response.failed`, three times.
- It ends its run with the suite's teardown.
- It takes 20 to 25 seconds, the longest story in the suite. Three held calls cost under half the default run budget, and each is settled before its response ends, so no continue is refused for pending billing.

## Steps

1. The fake's rule and its test. Verify: N4.
2. The story, before the fix. Verify: N3, with the trace kept.
3. The fix. Verify: N1 and N2.
4. `docs/verification.md` names auto-continue among the run journeys. Verify: N5.

## Ownership

Owned: `app/game-ui.tsx` for the one line in `send`; `tests/e2e/agent-script.ts`, `tests/e2e/openrouter-fake.ts` and `tests/e2e-openrouter-fake.test.ts` for the rule; one new story file under `tests/e2e/`; `docs/verification.md` if it lists the stories; this plan.

Not owned: `lib/`, `db/`, the other stories, `scripts/`, the workflows.

## Risks and open questions

- **A read for another session.** The counter is shared by the page, so a send in one session also drops a read that another session's ended response had in flight. That session's poll brings the state a moment later. The verifier weighed a per-session counter and recommended the shared one, which is what the page did before pull request 23.
- **An instruction the server truly rejects** is still found: the read that `send` makes when its own stream ends was requested after the send.
- **The story's length.** The limit's minimum is 5 seconds, and the chain needs three responses.
- **Releases.** Until the promotion fix on `fix/promote-by-api` merges, a merge stops before the domain moves and the lead finishes it by hand.

## Plan verification

An independent read-only check on 2026-11-27 approved with changes, all folded in. It confirmed the cause by reading and found it is a regression: the guard exists and `send` stopped advancing its counter in pull request 23. The fix is therefore one line and not the new marker the first draft proposed, which would also have left the stale read marking a running session idle. It showed the story's single wait could not span three responses, added the busy and empty-field assertions that make the failure specific, fixed the order of the declared failures and when the settings must be stored, and confirmed that three held calls fit the run budget and that the "no third continue" bound is sound.

## Review

An independent read-only review on 2026-11-27 approved the fix as correct and sufficient, with no P0 or P1 and one P2 in the story.

- **The fix.** The counter is read only by `refreshGame`, so advancing it on a send breaks no other comparison. It restores the guard on reads and not the single-session fencing that pull request 23 replaced, so it brings back nothing that change removed.
- **P2.** The story's two checks that the composer was busy would have passed without the fix, because the composer is busy in the instant a continue is sent and a poll marks it busy again within three seconds. The story now reads the composer from each continue until its stopped entry shows and fails if it is ever idle. With the fix removed, that check fails.
- **Also applied.** The stored instruction texts are asserted in order, the settings are stored inside the `try`, and the story waits for a response still in flight before its teardown, so a failing run does not log into the next story.
- **Left for a follow-up.** Three other paths can mark a running session idle from a stale read without the counter's guard: the poll while a stream runs, `loadSession`, and the stream's final frame. None can put text back in the field. The window is the gap between the server ending a response and the page reading the end of its stream.
