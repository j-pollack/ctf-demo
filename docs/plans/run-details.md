# Run details pane

Feature checkout: `/Users/jonathan/Code/ctf/.worktrees/readable-pages`, branch `feature/readable-pages`. This builds on the copy audit in `docs/plans/copy-audit.md`.

Audit: section 8 of https://artifacts.jonathanpollack.dev/a/xMAum37TH84SbJ6p (v3). The user approved building all of it on 2026-11-26.

## Problem

On an ended, caught run with two sessions, the pane is about 1,900 px tall at 360 px wide.

- **Order.** What caught the run sits below "What the monitor saw", the longest section.
- **Repetition.** The catch appears three times: the banner, the status line and "Decisions".
- **Unlabelled model.** The model line has no label.
- **Jargon.** Route names need a legend, and signal names are code identifiers.
- **Spend.** It shows the total and its parts as peers.
- **Headings.** All three heading levels look the same.

## Order (`app/run-inspector.tsx`)

1. h2 "Run details".
2. **Status** (h3 "Status"):
   - Active async run:
     1. The status label from `docs/plans/copy-audit.md`.
     2. The progress line, if any.
     3. "Last review {time}", time only, from `toLocaleTimeString` with hour and minute.
     4. "The monitor reviews a session each time the agent finishes responding, and every session in full when you submit."
     5. Show `monitor.reason` only when the status is `settling` or `unresolved`. Those reasons explain something; the others restate the label.
   - Caught run:
     1. `CAUGHT_BY[cause]`.
     2. Then "Session {n}, turn {t}." taken from the newest block decision.
     3. Then that decision's text when it differs from `caughtReason`.
     4. If there is more than one decision, a list "Earlier decisions" with the rest, each as today's receipt.
   - Other ended runs: the run's status label, as the run bar shows it.
   - The "Decisions" section is removed. Its content moves here.
3. **Spend** (h3 "Spend"). A sum, so the total reads as a total:
   - "Agent {$}"
   - "Classifier {$}"
   - "From your budget {$}", the total row, with a rule above it.
   - Then a separate line: "Monitor, not from your budget {$}".
4. **This run** (h3 "This run"):
   - "Agent: {model label}, {effort lowercase} effort", one line per distinct pair, with the full model id as `title`.
   - Then the existing rules lines.
5. **What the monitor saw**, ended runs only, last.

## What the monitor saw (`app/monitor-saw.tsx`)

- The intro is unchanged.
- Route labels (`ROUTE_TEXT.label`):

  | Route        | Label                   |
  | ------------ | ----------------------- |
  | investigated | Investigator read it    |
  | deferred     | Investigator skipped it |
  | final        | Final full review       |
  | none         | Stopped before deciding |

  Remove the legend list. Keep each meaning sentence as the label's `title`.

- The chart caption is "Classifier risk score at each review. A score never ends a run by itself." The x axis label is "Review number".
- Each session is a `<details>`:
  - The summary is "Session {n} · peak {p%}", with " · caught" when one of its reviews has verdict `block`.
  - The details element is `open` when a review in that session has verdict `block`. Otherwise it starts closed.
  - A session with no reviews has the summary "Session {n} · not reviewed".
- Signal names replace `name.replaceAll("_", " ")` with this map. An unknown name falls back to today's behavior.

  | Signal               | Label                                          |
  | -------------------- | ---------------------------------------------- |
  | reads_flag           | reads the flag file                            |
  | writes_flag          | changes the flag file                          |
  | stages_reader        | sets up something that points at the flag file |
  | hides_target         | obscures a path or command                     |
  | removes_traces       | deletes a script, log or history               |
  | changes_identity     | runs as another user                           |
  | instructs_reader     | gives orders to an AI reader                   |
  | claims_approval      | claims something was approved                  |
  | addresses_monitor    | written for the monitor                        |
  | overrides_rules      | tells the AI to ignore its rules               |
  | claims_authority     | poses as the system or monitor                 |
  | forges_record        | fakes a system or tool message                 |
  | unrestricted_persona | sets up a persona with no rules                |
  | hides_request        | disguises its request                          |
  | drops_safeguards     | tells the AI to drop its safeguards            |

- Screen verdict words (`SCREEN_TEXT`): clear "clear", unclear "classifier unsure", certain "classifier certain". So the label reads "Instruction · classifier unsure".
- Second look: "Second look: cleared." when the verdict is clear. Other verdicts are written as plain words.
- Footers:
  - "{n} other {command|commands} scored under {t}."
  - "No command reached {t}. {n} {command|commands} {was|were} checked."
  - "All {n} instructions and system prompts were clear." This replaces "No instruction or system prompt was unclear. {n} texts were clear."
  - "{n} other {text|texts} {was|were} clear." stays.
  - The output footers stay.

## Type (`app/globals.css`, `.inspector` only)

- Section h3 at 15 px.
- Session summaries at 14 px, weight 600.
- List labels (h5) at 12 px, muted.
- Body text at 13 px.
- The Spend total row has a top border.
- No other panes change.

## Checks

- **Tests first.** Update the pinned tests: `tests/monitor-saw.test.ts`, `tests/run-details.test.ts`, `tests/run-inspector.test.ts` and any others. Add tests for:
  - the new order (Status before Spend before This run before What the monitor saw);
  - the merged caught decision;
  - the spend sum;
  - the signal map and its fallback;
  - a session opening on a block verdict.

  Record the failures, then implement.

- `npm run check`.
- **Browser.** Render the ended caught run pane as in `.artifacts/details/render.tsx`, and the active-run pane in the layout fixture `four-1440-inspector`. Compare heights and order with the audit.

## Deviations and review

Accepted during development:

- **Caught runs.** A run counts as caught when `game.status` or `monitor.status` is `caught`. Legacy `blocked` runs are treated the same way.
- **Error-only decisions.** On a run that was not caught, investigation-error decisions are no longer listed. An error shows as the `unresolved` status with its reason.
- **Second-look wording.** A "jailbreak" second look reads "found an attempt to override the rules".
- **Single-text footer.** With one text, it reads "The only instruction or system prompt was clear."
- **Unscored sessions.** A session without scores has no peak in its summary.

The independent review found no P0 or P1 issues. Corrected after review:

- **Heading order.** List titles and "Earlier decisions" are h4, so the heading order goes h3 then h4.
- **Finalizing runs.** They keep the monitor progress, last review and reason in Status, without the per-response timing line.
- **Second review, P3s fixed with the user's approval.** A finalizing run leads with "Final review", with the monitor label beneath it. A legacy `blocked` run without a cause reads "Blocked", matching the run bar.
