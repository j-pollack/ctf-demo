# Play layout: session columns, compact run bar, inspector

Worktree: `/Users/jonathan/Code/ctf/.worktrees/play-layout`
Branch: `feature/play-layout`
Baseline: `44085782bfd2f6981007e58bb8cc96f239fd3578`. Clean index and worktree. `npm run check` passed with 278 tests before any edit. The primary checkout stays unchanged.

Roles: lead is Claude Fable 5.2. Planners, plan verifiers, developers and the code reviewer are Claude Opus agents, because the user asked for Opus sub agents. This departs from the dev-factory default of a medium-capability developer.

No commits, pushes or deployments are authorized for this task.

## Request

The user reviewed the play page at 1728 CSS px wide with a caught four-session run and listed eight problems.

0. Gutters and margins do not line up.
1. The viewport is wasted. Several sessions should be visible as columns when width allows. Narrow screens can use tabs, placed on the top or the side.
2. The top of the page takes too much height and crowds the transcript.
3. Run details is clunky.
4. The run id belongs up by the budget.
5. Remove "ONE RUN · SHARED STAKES / Fix a bug. Get the flag through. / Sessions share one computer, flag, and budget."
6. A session needs a loading state. Today an unloaded session shows the empty "your move" screen.
7. Turn counts belong to sessions. The run-level turn count is confusing.

The user also asked for a design that handles more sessions than fit as columns, and more tabs than fit in the viewport, so that a tenth parallel session can be tracked and reached.

## Causes found in the code

- Three regions use three inset systems. `.top` pads 20px inside a 1600px box. `aside.monitor` pads `max(28px, (100vw - 1064px) / 2)` from the viewport. `.transcript` is a centered `min(100%, 1120px)` column with 28px padding.
- The stack above the thread is the header, the `aside.monitor` band, the tab strip, the run bar and the collapsed system prompt. At 1728 px wide that is about 480 CSS px before the first transcript line.
- Only the selected session has events. `hydrateSessionViews` creates sibling views with `events: []`, and nothing records whether a view has been fetched. The thread shows `mission-intro` whenever `events.length === 0`, so an unfetched session looks empty.
- `prompt`, `systemDraft`, `live`, the thread ref and scroll tracking exist once, for the selected session. `sessionViews` already holds per-session events, draft, busy, stage, error and cursor. `sessionControllers` already allows concurrent streams.
- The poll fetches one session: `GET /api/games/:id?session=X&after=cursor`.

## Design

The palette, the monospace face and the terminal voice stay. This is a layout and information-architecture change, not a rebrand. The memorable element is the deck of live session columns. Everything above it is one quiet row.

### Layout at 1728 px, four sessions, inspector closed

```
|g| Capture the flag_                                   Rules  Rank  My Runs  Sign out  Play |g|   header, 48
|g| Run 27EEA982  $0.2364 left [meter] of $0.50  Risk 17%  Reviewing   1 2 3 4  Add session   Details  New run |g|   run bar, 44
|g| Session 1 · 4 turns   | Session 2 · 5 turns   | Session 3 · 6 turns   | Session 4 · 21 turns  |g|   pane headers, 36
|g| transcript            | transcript            | transcript            | transcript            |g|
|g| composer              | composer              | composer              | composer              |g|
```

`g` is the one gutter. The wordmark, the run id and the first pane share a left edge. The nav, the run actions and the last pane share a right edge.

### Layout at 1440 px, two sessions, inspector open

```
|g| Run ...  budget  risk  status   1 2  Add session                     Close details  New run |g|
|g| Session 1 · 4 turns            | Session 2 · 5 turns            | Run details              |g|
|g| transcript                     | transcript                     | spend, investigator,     |g|
|g| composer                       | composer                       | risk chart, decisions    |g|
```

### Layout at 390 px, ten sessions

```
|g| CTF_                    Rules Rank Runs Out Play |g|
|g| Run 27EEA982  $0.2364 left  Risk 17%   Details  New run |g|
|g| 1 2 3 4 5 6 7 >                                  + |g|   chip strip scrolls, add button stays put
|g| Session 4 · 21 turns · glm-5.3-flash             |g|
|g| transcript                                       |g|
|g| composer                                         |g|
```

### Decisions

- **D1. One gutter.** A single custom property sets the inline inset for the header, the run bar, the outcome strip and the deck at every width. The console uses the full viewport width. The 1600px cap and the centered 1120px transcript column go away for the console. Rules, Rank and My Runs keep their reading measure and take the same left edge as the header.
- **D2. One run bar.** One row holds the run id, budget left with its meter and total, pending charges, advisory risk, investigator status or run outcome, the session index, and the actions Add session, Details and New run. It wraps to a second row only when it runs out of width. The stakes copy and the run-level turn total are removed. The investigator's last-review time, progress text and reason move to the inspector.
- **D3. Panes, with capacity from measured width.** The client measures the content width `w` of the workbench, the row that holds the deck and the inspector. `paneCapacity(x) = max(1, floor(x / 400))`. Panes have no gap. A 1px rule and padding separate them. The deck gets `w` when the inspector is closed or an overlay, and `w - 320` when it is a column. The deck shows `min(capacity, sessions)` panes in ordinal order, equal widths. A capacity of one is the tab layout. No separate mobile component exists. Before the first measurement, capacity is one and the inspector is closed.
- **D4. The session index is a top strip of numbered chips at every width.** A top strip maps onto the columns: chip 3 sits left of chip 4, as pane 3 sits left of pane 4. A side rail breaks that mapping, costs width that panes need, and needs a second orientation on phones. Ten chips take about 340px on a desktop and scroll inside the strip on a phone. The Add session control sits outside the scroller so it is always reachable.
- **D5. Chips carry status.** Each chip shows the ordinal and whether the session is shown in a pane, focused, running, the caught session, or hidden with turns the player has not seen. The accessible name spells this out, for example "Session 7, 12 turns, running, hidden". The strip shows a cue at an edge when more chips lie beyond it, and scrolls the focused chip into view.
- **D6. Choosing which sessions are shown.** The client keeps a most-recently-focused list. Activating a hidden chip shows that session and drops the least recently focused one. Activating a shown chip focuses its pane. A new session is shown and focused. Focus or pointer-down inside a pane focuses its session, so the pane in use is never the one evicted. When capacity grows, hidden sessions fill the new panes in ordinal order. The focused session is the one named by `?session=` in the URL.
- **D7. Each pane is a complete session.** It has a header with the session name, its own turn count, its running state, its model and effort, and the system prompt disclosure. It has its own transcript, scroll-follow state, live streaming turn, error, composer with its own draft, and Stop. Sending in one pane does not disturb another.
- **D8. Loading state.** A session view records whether its events have been fetched. An unfetched pane shows a loader with a status role. A failed fetch shows the error with Retry inside the pane. The "your move" prompt shows only for a fetched session with no events.
- **D9. Run details become an inspector column.** Details toggles a 320px column at the right of the deck with spend, investigator status, the risk chart and decisions. It stays open next to the transcripts, so risk can be watched while playing. It opens by default when `w - 320` still fits `min(sessions, paneCapacity(w))` panes and `paneCapacity(w) > 1`. The player's toggle then wins for the rest of the visit. When `w - 320 < 400`, an open inspector covers the deck, the deck is inert, and the same control or Escape closes it. The control keeps the label "Details" and exposes expanded state. Decisions list every loaded session, each labelled with its session.
- **D10. One outcome strip.** A finished or finalizing run shows its outcome once, in a strip between the run bar and the deck, at the shared gutter. It reuses `BlockedNotice` and `endBanner`. Copy that depends on transcript events is derived from the loaded sessions, as it is from the selected session today. It names the caught session with a control that shows and focuses that session. Panes do not repeat it. The strip is capped at `min(30dvh, 240px)` and scrolls inside itself. The Continue run control for an active run opened from My Runs also lives here.
- **D11. Fetching.** A pane fetches its session whenever it becomes shown: a full fetch the first time, a cursor delta after that. Polling covers every shown session that has no local stream. Hidden sessions fetch no events. Their chips update from the session summaries that every run snapshot already carries.
- **D12. Labels.** New labels use sentence case and plain words: "Run 27EEA982", "$0.2364 left", "Risk 17%", "Add session", "Details", "Session 2", "5 turns". No new all-caps eyebrow labels and no middle-dot strings in new markup beyond a single separator in a pane header.

### Plan review against the brief

A left rail of labelled session rows was the first idea for the overflow case. It was dropped for the reasons in D4. A horizontally scrolling deck of all panes was dropped because every pane would fetch and poll, and a tenth pane would be three screens away with no fixed place. A modal for run details was dropped because the risk chart is feedback the player wants while the transcript moves.

## Non-goals

- No backend, API, schema or billing change. No new endpoint. No dependency other than `@ui-sdk/core` and `@ui-sdk/react`, which the user installed in the worktree on 2026-11-14 together with the `ui-sdk` skill and asked the developer to evaluate. They may replace hand-rolled keyboard, focus and dismissal behavior in the chip strip and the inspector overlay. They do not change the markup contract's names or the visual identity.
- No change to Rules, Rank, My Runs list or landing content beyond the shared header inset.
- No drag to reorder or resize panes. No persisted layout preference.
- No change to auto-continue rules, monitor behavior or copy that this request does not name. No change to the server fork route, fork logic in `lib/` or their tests.
- `app/game-ui.tsx` is not refactored wholesale. New code goes in new focused files and the markup it replaces leaves `game-ui.tsx`.

## Audit follow-up

`docs/plans/play-layout-ui-audit.md` is a read-only audit of this branch's uncommitted work. The user asked the developer to act on it on 2026-11-14 and answered its open questions: remove the disabled fork feature from the client (F2c, client path only), and do both optional ui-sdk swaps, Dialog (F1c) and Meter (F1d). The audit's findings F1a through F4b are in scope in its recommended order. Its "Keep as they are" list binds the developer.

## Assumptions

- A1. A handful of concurrent `GET /api/games/:id?session=` polls per three seconds is acceptable, bounded by capacity. The planner must confirm no rate limit rejects it.
- A2. `SessionSummary.turns` is current enough for hidden chips. Shown panes use the larger of the summary and the highest agent turn in their events.
- A3. The user's screen is 1728 CSS px wide. Four panes of at least 400px fit there with the inspector closed.

## Criteria

- **L1.** Given the console at 390, 1024, 1440 and 1728 px, then the left edges of the wordmark, the run bar content, the outcome strip and the first pane are equal within 1px, and so are the right edges of the nav, the run bar actions and the last pane or inspector. The document has no horizontal overflow.
- **L2.** Given an active run at 1440x900, then the first pane's thread starts at most 140px below the viewport top. At 390x844 it starts at most 190px below.
- **L3.** In the run bar, the pane headers and the inspector: the strings "ONE RUN", "SHARED STAKES", "Fix a bug. Get the flag through." and "Sessions share one computer, flag, and budget." do not render, and no run-level turn total renders. The run id renders in the run bar next to the budget at every width. The win line in the outcome strip keeps "spent over N turns", because the leaderboard breaks cost ties on that number.
- **P1.** `capacity` is a pure function of deck width. Given 4 sessions at a deck width that yields capacity 4, all four panes render. Given 10 sessions at capacity 3, three panes render and ten chips render.
- **P2.** Shown-set rules from D6 hold as a pure function: activating a hidden session evicts the least recently focused, activating a shown session changes focus only, capacity growth fills by ordinal, capacity shrink keeps the most recently focused, a removed or unknown id is ignored.
- **P3.** Each pane shows its own session's turn count, and two panes with different counts show different numbers.
- **P4.** Given two shown sessions, typing in one composer does not change the other's draft, sending in one leaves the other's composer enabled, and Stop aborts only its own session's stream.
- **P5.** Given a session whose events have not been fetched, its pane shows the loader and not the "your move" prompt. After the fetch it shows the transcript, or the prompt when the session has no events. A failed fetch shows an error with Retry in that pane.
- **P6.** Given a hidden session whose summary turn count rises, its chip shows the unseen marker until the session is shown. A running session's chip shows the running marker. The caught session's chip is marked.
- **P7.** With 10 sessions at 390px, the chip strip scrolls inside itself, the document does not overflow, Add session stays visible, and the focused chip is in view after selection by click, by keyboard and by direct `?session=` load.
- **I1.** Details toggles the inspector. Its control exposes expanded state. In column mode panes stay usable and focus does not move. In overlay mode it covers the deck, the deck is inert, focus moves to the inspector heading, and Details or Escape closes it and returns focus to Details.
- **I2.** The inspector default follows D9 as a pure function of the player's choice, deck width and session count.
- **I3.** The inspector shows spend, investigator status with progress, last review and reason, the risk chart for all sessions, and decisions labelled by session.
- **O1.** A caught run shows one outcome strip with the caught session and reason, and no pane repeats it. Its session control shows and focuses that session. Captured, exhausted, ended and finalizing runs show their existing copy once in the strip.
- **K1.** Chips are reachable and operable by keyboard with visible focus. Arrow keys, Home and End move focus between chips without activating. Enter or Space activates. Pane regions are labelled by session. Motion respects `prefers-reduced-motion`.
- **R1.** Existing behavior holds: per-session drafts and system prompt drafts, concurrent streams, auto-continue, terminal-run guards on new sessions and instructions, deep link by `?session=`, My Runs detail view read-only panes, Continue run. `npm run check` passes.

## Checks

| Criterion          | Check                                                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------------------------- |
| P1, P2, I2, P6     | Unit tests on a new pure module, written first and seen failing                                                 |
| P5                 | Unit test on `session-ui-state` for the fetched flag, plus SSR test of the pane                                 |
| L3, P3, O1, I3     | SSR tests of the extracted components with fixtures                                                             |
| L1, L2, P7, I1, K1 | Browser inspection with measurements at 390, 1024, 1440, 1728 px                                                |
| P4, R1             | Existing session-state tests, new pure tests where logic moves, browser scenario if a local harness is feasible |
| All                | `npm run check`, `npm run test:coverage`                                                                        |

Browser checks must not use `.env.local` credentials or paid services. A static fixture render of the real components with the real stylesheet is acceptable for L1, L2, P7 and K1. Interactive behavior that cannot be exercised without live services is reported as unrun.

## Plan verification

Two independent Opus planners reviewed this contract on 2026-11-14. One covered state and data flow, the other layout, CSS and accessibility. Both read the code and neither edited it. Their blocking findings are resolved above and below.

- Capacity is measured on the workbench, not the deck. Measuring the deck makes the inspector default oscillate. D3 and D9 now say so.
- Arrow keys on chips move focus only. Today they select, which under D6 would evict a pane and start a fetch on each key press. K1 now says so.
- Using a pane focuses it. D6 now says so.
- The run bar is a three-area grid whose chip track is `minmax(0, 1fr)` and scrolls. It becomes two fixed rows at 960px and below. A flex row that wraps did not fit at 390px and wrapped unpredictably at 1440px.
- L3 conflicted with the win line. L3 now exempts it.
- The system prompt summary sits in the pane header row. On its own row the thread starts at about 179px at 1440x900 and fails L2.
- `id="prompt"`, `id="system-prompt"` and `id="session-panel"` become per-session ids.
- `.error[role="alert"]` also matches dialog and `.info` errors. The gutter applies to `.workspace > .error[role="alert"]` only.
- `.app { overflow: hidden }` hides overflow from `document.scrollWidth`. The L1 overflow check tests elements.

Facts the planners verified: no rate limit applies to `GET /api/games/:id` in this repo, and each GET costs about ten queries (A1; hosting limits unverified). `event.turn` is the session's turn (A2). The run-level `pending`, `unconfirmed` and `reconcile` in `GameUI` are dead code: `pending.current` is never assigned. A session can stay "unconfirmed" forever today when its stream ends without a `user` event. The per-session reconcile in step 4 fixes that.

## Markup contract

Both developers build to these names. The CSS developer writes rules for them. The component developer renders them.

```
div.app > div.workspace
  header.top                                   SiteHeader, unchanged markup
  div.error[role=alert]*                        global errors only
  div.console
    header.run-bar
      div.run-stats
        span.run-id            "Run " strong "27EEA982"
        span.run-budget        strong "$0.2364 left"  span.run-meter > span[style=width]  span.run-total "of $0.5000"  small.run-pending[role=status] "$0.0841 pending"
        span.run-risk[data-band][title][aria-label="Classifier risk 17%, advisory"]  "Risk 17%"   (active runs; "No risk data yet" before any observation)
        span.run-status[role=status][data-band]   investigator status while active, run status or outcome otherwise
      div.run-sessions
        div.chips[role=toolbar][aria-label=Sessions]
          button.chip[type=button][data-shown][data-caught][data-unseen][aria-current=true][aria-controls=pane-{id}][aria-label][tabIndex]   optional <i aria-hidden/> when running, then the ordinal
        button.session-add[type=button]   "+" span.add-label " Add session"
      div.run-actions
        button.details[aria-expanded][aria-controls=run-inspector]  "Details"
        button.new-run  "New run"
    section.outcome[aria-label="Run outcome"]     only when there is something to say; holds .terminal, .stage or the Continue run control
      button.link.outcome-session                 "Show session 4"
    div.workbench[data-inspector="column"|"overlay"]     measured element; attribute absent when closed
      div.deck[style="--panes:N"][inert when overlay]
        section.pane#pane-{id}[aria-labelledby=pane-title-{id}][data-focused]
          header.pane-head
            h2#pane-title-{id} "Session 2"
            span.pane-turns "5 turns"
            span.pane-running  <i aria-hidden/> "Running"
            span.pane-model[title]  "glm-5.3-flash · Low"
            details.system-prompt   summary: "System prompt" + span.unsaved (visually hidden text "Sends with next instruction"); body: span.hidden-tag, textarea#system-prompt-{id} or p
          div.thread[tabIndex=0][aria-label="Session 2 transcript"][aria-busy]
            p.stage[role=status]  <i aria-hidden/> "Loading session 2…"      when not fetched
            div.error[role=alert] … button.link "Retry"                       when the fetch failed
            div.empty.mission-intro                                           when fetched and empty
            article.entry* , article.entry.agent.live , div.stage[role=status]
          form.composer   label.visually-hidden[for=prompt-{id}]  textarea#prompt-{id}  button  small.send-hint
      aside.inspector#run-inspector[aria-labelledby=inspector-title]
        h2#inspector-title[tabIndex=-1] "Run details"
        section  Investigator: strong status, small progress, small last review, small reason
        section  .risk-heading + .run-risk-chart
        section  Decisions: .receipt*, each header names "Session N"
        section  Spend: .spend-breakdown
```

Chip encoding, each state with a cue besides colour: hidden is a dashed outline in muted ink. Shown is a solid outline. Focused is bold with a 3px underbar. Running is the pulsing square `i`. Caught is inverted on `--blocked`. Unseen is a 6px round dot at the top right, the only round mark in the interface. Chips are 32px on fine pointers and 44px on coarse pointers. So are run bar and pane header controls.

The chip strip shows more-content cues with the `background-attachment: local` shadow technique, so chip backgrounds stay transparent except focused and caught.

## Implementation plan

Constants: `PANE_MIN = 400`, `INSPECTOR_WIDTH = 320`. CSS uses the same 320px track and does not repeat 400.

### Component developer: state, logic, components

The design keeps a focused session. `selectedSessionId`, `selectedSessionRef`, `?session=`, `projectSelectedSession`, `keepSelectedSessionProjection` and `refreshedGame` stay, because they carry the request fencing and terminal-state guards. No render path reads `game.events` after this change. Every pane, auto-continue, the decisions list and the outcome strip read `sessionViews[id]`.

New and changed files:

- `app/transcript.tsx`: pure move of `LiveTurn`, `LiveDelta`, `withDelta`, `partialArgument`, `liveCall`, `Call`, `displayCommand`, `groupTurns`, `Entry`, `BlockedNotice`, `SuspicionBadge`, `CallOutput`, `suspicionBand` and the constants they use. `game-ui.tsx` re-exports them so test imports hold.
- `app/run-format.ts`: pure move of `money`, `label`, `EFFORT_NAMES`, `statusLabel`, `monitorStatusLabel`, the run budget constant. Re-exported.
- `app/session-layout.ts`: pure. `paneCapacity(width)`, `deckLayout(width, sessions, choice)` returning `{ capacity, inspector: "closed" | "column" | "overlay" }`, `focusRecent(recent, id, ids)`, `shownSessionIds(ids, recent, capacity)`, `sessionTurns(summaryTurns, events)`, `nextSeenTurns(seen, sessions, shown)`, `chipLabel(...)`, plus `sessionIsRunning` and `nextTabIndex` moved from `session-tabs.tsx`.
- `app/session-chips.tsx` replaces `app/session-tabs.tsx`.
- `app/session-pane.tsx`: header, thread, loader, error, composer, scroll follow. `SystemPrompt` and `systemPromptChange` move here. Keyed `${runId}:${sessionId}`.
- `app/run-bar.tsx`, `app/run-inspector.tsx`.
- `app/run-console.tsx`: a pure view that composes run bar, outcome strip, workbench, deck, panes and inspector from props and takes the workbench ref. `GameUI` is the state container and renders `RunConsole`. This makes the console renderable from fixtures for SSR tests and browser measurement.
- `app/session-ui-state.ts`: `SessionUIState` gains `fetched: boolean`, `live?: LiveTurn` and `systemPrompt` (the stored base). `createSessionUIState` sets `fetched` when `events` is passed. `applySessionSnapshot` sets it true. `mergeSessionEvent` does not. `stopAllSessions` keeps it and clears `live`. `isVisibleSessionStream` is deleted.
- `app/run-risk-chart.tsx`: width 300 so axis text stays legible in a 320px column.

Steps, each verified with `npm run check`:

1. Pure moves with re-exports. Zero test edits.
2. `session-layout.ts`, tests first and seen failing: P1, P2, I2, P6, chip labels.
3. `SessionUIState` fields, tests first: P5 unit.
4. Remove the one-session mirrors while the page is still one pane: delete `prompt`, `systemDraft`, `live`, `sessionLive`, the dead `pending`, `unconfirmed`, `reconcile`, and the `systemBase` effect. `send(sessionId, auto?)` reads `view.draft` and `view.systemPromptDraft`. `receive` writes `view.live`. `refreshGame` reconciles `sessionPending` per session with `instructionStatus`, and its non-focused branch gains an `olderGameSnapshot` guard. `hydrateSessionViews`, `ensureSessionView` and `createSession` pass `events` only for `run.sessionId`. Hydration applies `nextSystemDraft` per session. Fork, `continueHistoryRun`, account switch and `start` drop the mirror setters. Account switch resets `sessionViews`. All fences stay.
5. `SessionPane` with SSR tests for P3, P5 and the rendered half of P4. `GameUI` renders one pane.
6. Deck: workbench measurement with `useLayoutEffect` and `ResizeObserver`, `recent`, `inspectorChoice`, `deckLayout`, `shownSessionIds`. Split `selectSession` into `focusSession` and `loadSession`. In `loadSession` the `setHistorySelected` and `setGame` branches run only for the focused id, otherwise a non-focused load changes `historySelected.sessionId`, re-runs hydration and moves focus. Load-on-show effect. Pane interaction focuses. Auto-continue loops over shown sessions on the execution view.
7. Polling for every shown session without a stream, for the live run and for the My Runs detail view. One in-flight flag per tick.
8. `SessionChips`, `RunBar`, `RunInspector`, outcome strip, `RunConsole`. Delete `RunRiskBrief`, `RunDetails`, the stakes copy, the run turn total and `session-tabs.tsx`. Update the tests that asserted removed markup.
9. `seen` state for the unseen marker.
10. `npm run check` and `npm run test:coverage`.

Riskiest steps: 4, 6 and 7.

### CSS developer

Owns `app/globals.css` only. Works from the markup contract.

- `:root { --gutter: 24px }`, 12px at 720px and below. `.app` loses `max-width` and `margin`. `.top` pads `0 var(--gutter)` with `min-height: 44px` on every page. `.info` pads `32px var(--gutter)`. `.workspace > .error[role="alert"]` takes the gutter. `.landing-main` takes the gutter.
- Run bar grid, chips, deck `repeat(var(--panes, 1), minmax(0, 1fr))`, panes with `container: pane / inline-size`, `.thread { overflow-wrap: anywhere }`, pane content measure capped at 1064px and left-aligned, inspector column and overlay, outcome strip.
- Pane internals at 400px through `@container pane (max-width: 560px)`: `.entry.user` margin, composer button width, intro heading size.
- Delete the rules for `aside.monitor`, `.stakes-*`, `.budget`, `.risk-brief`, `.monitor-progress`, `.turn-total`, `.transcript`, `.column-head`, the old `.run-bar*`, `.session-strip`, `.session-tab*`, `.session-new`, `.system-prompt .preview`, and their media rules. Keep everything the landing, admin, Rules, Rank and My Runs pages use.

### Integration and browser measurement

`scripts/layout-fixture.tsx` renders `SiteHeader` and `RunConsole` with fixture runs of 1, 4 and 10 sessions, active and caught, inlines `app/globals.css`, and writes `.artifacts/layout/*.html`. Capacity comes from the same pure function. `agent-browser` opens each file at 390x844, 1024x768, 1440x900 and 1728x1000, takes screenshots and evaluates the L1, L2 and P7 measurements. Chip keyboard behavior and the inspector toggle are exercised if the fixture can be hydrated with the `esbuild` already in `node_modules`. Otherwise they are reported as unrun.

## Evidence

Pending.

## Evidence

Recorded 2026-11-14. Nothing here used `.env.local`, a dev server or a live service.

### Gates

- `npm run check` exits 0 with 321 tests, against 278 at baseline. `npm run test:coverage` exits 0.
- `.oxfmtrc.json` ignores `.agents/skills/ui-sdk/**`, as it already ignores the neon skills. The pre-commit hook rejected the vendored skill's formatting before that.
- `git diff 4408578 --stat -- lib app/api db` is empty. No server code changed.

### Browser measurement

`scripts/layout-fixture.tsx` renders `SiteHeader` and `RunConsole` from `tests/fixtures/console-runs.ts` with the real stylesheet, hydrated with the `esbuild` already in `node_modules`. The developer, an independent QA agent and the lead each drove the pages with `agent-browser` and viewed screenshots. Interactive checks used Chrome DevTools Protocol input events.

| Criterion      | Result                                                                                                                                                                                                                                                |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1             | Left edges of the wordmark, run bar and first pane are 12px at 390 and 24px at 1024, 1440 and 1728. Right edges of the nav, run actions and last pane or inspector are 378, 1000, 1416 and 1704. No element or document overflow on 20 fixture pages. |
| L2             | Thread top is 127px at 1440x900, including a pending charge and a running session. At 390x844 it is 150 to 171px with a fine pointer and 174px with a coarse pointer.                                                                                 |
| L3             | The four stakes strings are absent from the DOM on every fixture. No run-level turn total. Run id on the budget row at every width. Also covered by SSR tests.                                                                                        |
| P1, P2, I2, P6 | Unit tests in `tests/session-layout.test.ts`, seen failing first. Browser: 4, 3, 2 and 1 panes at 1728, 1440, 1024 and 390 with four sessions. Ten sessions at 1440 show 3 panes and 10 chips.                                                        |
| P3             | SSR test. Browser: panes show 4, 5, 6 and 7 turns.                                                                                                                                                                                                    |
| P4             | Rendered half in SSR. Browser: typing in one composer leaves another pane's draft unchanged, and a send in one pane leaves the other composer enabled. Stop against a real stream is unrun.                                                           |
| P5             | Unit and SSR tests. Browser: loader and Retry render inside their panes.                                                                                                                                                                              |
| P7             | Ten sessions at 390: the strip scrolls inside itself, Add session stays visible, and the focused chip is in view on load, after click, after keyboard activation and after a resize from 1728.                                                        |
| I1             | Column mode keeps focus on Details. Overlay mode makes the deck inert, focuses the inspector heading, and Escape or Details closes it and returns focus.                                                                                              |
| I3, O1         | SSR tests. Browser: one outcome strip, 144px tall at 1024 and wider with a three-line reason. "Show session 4" shows and focuses that session.                                                                                                        |
| K1             | One tab stop on the focused chip. Arrows, Home and End move focus without changing the shown panes. Enter and Space activate. Focus ring visible. Pulses stop under reduced motion. No duplicate ids.                                                 |
| R1             | `npm run check`. Request fences verified by independent code read. Interactive behavior against live services is unrun.                                                                                                                               |

### Review

An independent Opus reviewer read the full delta against the baseline. First pass: no P0 or P1, two confirmed P2 findings. One corrective cycle followed, with a regression test first for each. Re-review: both resolved, no P0 to P2 outstanding.

- The My Runs detail view stopped updating run-level state after focus moved to another shown pane. Fixed by `refreshedDetailRun`.
- A sibling pane could stay on its loader when its fetch was dropped by a route or account change. Fixed by `nextShownLoads` and by forgetting a load that applied nothing.

Open P3 findings, reported and not fixed:

- A sibling load in flight when the player presses Back from `/runs/X` to `/play` for the same live run can leave that pane on its loader until the shown set changes. Active async runs recover through the poll within three seconds.
- The chip tab stop stays on the focused session's chip, not the chip the arrows last reached.
- `router.replace` runs on each pane focus to update `?session=`.

### ui-sdk and the audit

Adopted: `useShortcut`, `ScrollArea` with `stickToEnd`, `Meter`, `Dialog`. Declined: `Toolbar`, because it has no way to put the initial tab stop on the focused chip, which K1 requires. The reviewer confirmed that against the Toolbar docs. Scroll-follow changed in one respect: the old code kept following within 48px of the end, and `stickToEnd` follows only at the end.

Audit findings F2a, F2b, F2d, F3a to F3e, F4a, F4b, F1b, F1c, F1d and F2c (client path) are done. F1a is declined for the reason above.

### Limits

- At 390px the chips share a row with Details and New run, so about four chips show at once. The strip scrolls and keeps the focused chip in view.
- At 390px a caught run's outcome strip is 240px tall and the thread starts at 389px.
- Unrun, because they need live services: real fetching, polling, streaming, Stop, auto-continue, Continue run, deep links through the Next router, and the landing, Rules, Rank and My Runs pages. These need a preview deployment check before promotion.
