# Monitor review view

Worktree: `/Users/jonathan/Code/ctf/.worktrees/monitor-review-view`, branch `feature/monitor-review-view`, from `feature/screen-actions` at `0c5fe12`.

## Problem

The play screen shows a classifier risk score: a control in the run bar, a chart in Run details, a badge on each reviewed command and a percentage on monitor blocks. Players steer by it during a run, so it works as a feedback loop against the monitor. The score is also in the public game payload, so hiding it in the UI alone would leave it one request away.

After a run, the owner has no way to see what the monitor did: which reviews ran, how each was routed, and which commands, outputs and texts the classifier flagged.

## Design

1. The play screen shows no score. The run bar control, the Run details risk section, the transcript badges and the percentages on monitor blocks and decisions are removed, with their copy and CSS.
2. `publicGame` strips `suspicion` from every event while the run's status is not terminal. `listSessionSummaries` stops computing `riskHistory`, which only fed the removed chart. Every route that returns a game, and the runner's `done` frame, goes through `publicGame`.
3. `GET /api/games/[id]/monitor-view` returns the monitor view. It reads the run with `getPublicGameRow(id, owner)`, which validates the id and answers 404 to anyone but the owner. It answers 409 while the run is creating, active or finalizing.
4. Run details gains a "What the monitor saw" section on a terminal run only. It fetches the route when Run details opens. Per session it shows:
   - each review in order: time, route with a one-line meaning, verdict, and the reason where one exists;
   - the chart of each review's risk score, one line per session, its x axis now the review number;
   - commands whose classifier answers crossed the routing threshold, outputs the classifier flagged with the answers that flagged them, and instructions or system prompts whose screen was unclear or certain with the second look's verdict. Each list states how many others stayed under the threshold.
5. The rules page describes the view once, in the glossary. The view and the glossary say it could not influence that run. Across runs it can: a player can end a run and reword the next. That trade-off is with the user, not this change.

## Decisions

- Terminal means `captured`, `exhausted`, `ended`, `blocked` or `caught`. The no-result endings are `ended` with an `endReason`. The check moves to `lib/types.ts` as `runHasEnded` so the server and the client share one definition; `isTerminalRunStatus` delegates to it.
- `publicGame` keeps sending `suspicion` after the run ends, as the user asked. No UI reads it there. The view reads scores from its own route.
- A review's score is the largest `suspicion` on the events that carry its `review_id`. A review without one is listed and left off the chart.
- The routing threshold rule moves into an exported `routingSignals` in `lib/monitor-route.ts`, which `chooseRoute` also uses, so the view and the router cannot disagree. Flagged outputs use `labelSignals`, now beside `injectionVerdict` in `lib/text-screen.ts` and the source of its verdict, so an output lists only the answers that labelled it: `instructs_reader` at 0.5 or any answer at 0.8. Screens use `jailbreakVerdict`. These are the rules the monitor acts on.
- The view sends question names and values, not raw rows. It never sends the flag, `secret_hash`, `operational_error`, evidence, prompts or other runs' rows. Command text comes from this run's `sprite_operations`. Instruction and system-prompt text is matched by hash against this run's transcript and refused texts, which the owner already sees.
- Route meanings say whether the investigator read the session, not why. An investigated route can come from a crossed answer, a command naming `flag.txt`, a labelled output, an unclear screen or an unannotated call, and the signal is not stored. Final reviews follow a submission, which a run that ran out of budget or was abandoned never has.
- The payload carries only what the panel shows: no target kind and no completion time.
- Risk score colour bands stop at high, so a score of 1 on an allowed review never takes the caught colour. The band lives in `app/monitor-saw.tsx`, its only user.
- `parseMonitorView` checks the route's answer before the panel uses it, and is a pure function so it is tested without network.
- A deferred review's stored reason repeats the route's meaning, so the view shows reasons only for other routes.
- A review with no route stopped before routing: a second look caught a jailbreak, or the review failed.
- The view carries `commandThreshold` (0.5) from `lib/monitor-route.ts`, because the client cannot import that server module and should not repeat the number.
- Verdicts read "Allowed", "Caught", "No result" and "Did not finish". "Caught" covers a jailbreak catch as well as a flag read.
- A session the classifier never checked gets one line instead of three empty lists.
- The old chart's pre-turn point and `app/run-risk.ts` go away, since the series now comes from reviews.

## Acceptance cases

- A1: During play, in both jailbreak-catch settings, the run bar, Run details and transcript show no risk score, badge or percentage.
- A2: A score-only monitor event renders nothing in the transcript whether or not it carries `suspicion`.
- A3: The landing page does not mention a risk score. The rules page does not describe one during play. Its glossary describes "What the monitor saw" once, which names the risk score once.
- A4: Run details on a creating, active or finalizing run has no "What the monitor saw" section. On a terminal run it has the section, with loading, error, empty and filled states.
- A5: The filled section lists reviews with route labels and meanings, verdicts and reasons; charts scores per review; and lists crossed commands, flagged outputs and unclear or certain screens with counts of the rest. A response that is not a view shows the error.
- R1: The route answers 401 without a session and 404 for a malformed id, an unknown run, or another player's run.
- R2: The route answers 409 while the run is creating, active or finalizing.
- R3: The route answers 200 for each terminal status with the expected structure, and the body contains no flag, secret hash, operational error or other run's text. An output flagged only by a strong answer lists that answer alone.
- R4: `GET /api/games/[id]` sends no `suspicion` and no `riskHistory` while the run is creating, active or finalizing, and sends `suspicion` once it has ended. `POST /api/games/[id]/sessions` on an active run answers with no `suspicion` and no `riskHistory`.
