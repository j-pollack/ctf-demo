# Live billing and transcript cleanup

- Checkout: `/Users/jonathan/Code/ctf/.worktrees/hidden-system-prompt`
- Branch: `feature/hidden-system-prompt`. The user chose to keep this on the same branch (overriding the one-feature-per-worktree rule), so it can be tested on localhost:3002 next to the hidden system prompt.
- Builds on: the hidden-system-prompt revision 2 delta (uncommitted at the start).
- Roles: lead Claude Opus 5.5 (high); verifier and reviewer independent Opus subagents (high, read-only); developer Sonnet subagent (medium).

## Contract

User report: "billing should update with each call, not at the very end of a turn"; the chat view has (a) nested scroll areas that capture scrolling, (b) annoying auto-scroll, (c) tool output separated from its tool call, (d) oversized Copy/Fork buttons.

1. **Live billing.** Each inference call (agent and monitor) already settles in `ctf.inference`/`ctf.games` when it finishes. The UI learns new totals only from the final `done` SSE frame, because polling is off while a response streams.
   - Add a pure-SQL helper in `lib/games.ts` returning `{ budgetMicrodollars, spentMicrodollars, reservedMicrodollars, agentSpendMicrodollars, monitorSpendMicrodollars }` for a game. `publicGame` reuses it, so there is one source of truth.
   - The runner sends an SSE `billing` frame with those totals right after every recorded event (`emit`). An agent event follows its settled agent call; a monitor event follows its settled monitor call.
   - The client merges `billing` frames into the live game, under the same run/epoch/owner/generation guards as the `event` branch. No new endpoint, no polling change.
   - The server billing read is best-effort (`.catch(() => {})`). A failed read must not turn a recorded event into an interrupted response; `done` is the backstop.
   - Every settle path is covered: settle-then-fail emits an error or monitor-error event, `knownUnbilled` refunds settle before the error emit, and `done` follows everything.
2. **One scroll container.** Only `.thread` scrolls vertically inside the transcript. Remove `max-height`/`overflow` from these, so they expand inline:
   - transcript descendants: `.entry pre`, `.entry.tool p`, `.entry details p`;
   - `.system-prompt p`.

   Long lines already wrap: `pre` is globally `pre-wrap`/`overflow-wrap: anywhere`.

   Also fix two thread leaks:
   - Scope `.monitor { overflow: auto … }` to `aside.monitor`. It currently also matches `article.entry.monitor`.
   - Make the in-thread `.error[role="alert"]` not a vertical scroller.

   `.markdown table` keeps its horizontal scroll. The side panel's own scroll, the fork preview and the dialogs are out of scope.

3. **Follow only at bottom.** Keep an "at bottom" flag (a ref):
   - Set it when the thread is within ~48px of the bottom.
   - Clear it only when `scrollTop` decreases, i.e. the user scrolled up. That way a smooth scroll in progress never unsets it.
   - On new events/stage/billing, scroll only if the flag is set.
   - Sending an instruction (`unconfirmed`) or switching runs (`routeRunId`) always scrolls to the bottom and sets the flag.
   - Scroll the thread element itself (`thread.scrollTo`), not `scrollIntoView`. Reduced-motion is respected.
4. **Tool output under its call.** A pure, exported `groupTurns(events)` (in `app/game-ui.tsx`, or a small `lib/` module if cleaner):
   - attaches each monitor event (allow/block/error, which carries `command`) and the tool event that follows it to the preceding agent event as a call `{ command, decision, reason, output }`.
   - The agent entry renders reasoning, then text, then each call: the command `pre`, then directly beneath it the tool output or the block/error reason.
   - Allowed monitor events stay invisible except for producing the call.
   - Attach a tool event only when it **immediately** follows a monitor event; otherwise it stays standalone. This covers invalid args, length-stop and pre-monitor blocks.
   - Absorb the tool event after a block (`"Blocked"`) and after a monitor error (`"Operation aborted"`), and show the monitor's reason with a distinct label: "Blocked" / "Monitor error".
   - Tolerate monitor events with no `command`.
   - **Unreviewed calls stay visible.** Let `joined = calls.map(c => c.command).join("\n")`. If `agent.command.startsWith(joined)` and is longer, render the remainder `agent.command.slice(joined.length + 1)` as a plain command `pre` after the calls (not yet reviewed, or never run after an error). Otherwise render no remainder.
   - With zero calls, fall back to today's single command `pre`.
   - User, error and orphan events render as today.
   - `ForkPreview` groups `events.slice(0, selectedIndex + 1)`. The selected agent then shows its commands without outputs, matching what the fork copies.
   - Monitor side panel receipts are unchanged.
5. **Compact Copy/Fork.** Move them into the agent entry header row, at the right with `margin-left: auto`; the header already wraps.
   - Small icon buttons, about 28px (meets WCAG 2.5.8's 24px).
   - Still with `aria-label` and a visible keyboard focus.
   - No separate row. The hover/focus label may be dropped.

Non-goals: streaming token-by-token output, changing billing accounting/settlement, redesigning the side panel, fork semantics.

## Criteria and proof

| ID  | Given/when/then                                                                                                                                                                                                                                                                                                                                                                                                                                              | Check                                            | Status |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ | ------ |
| L1  | The fake OpenRouter returns distinct nonzero costs for agent and monitor calls. During one instruction the client receives a `billing` frame after each recorded event, carrying the exact cumulative `spentMicrodollars` and agent/monitor split; a frame lagging one call behind fails. The final frame deep-equals `done`'s billing fields (covers L2). A monitor "invalid" turn's frame after the monitor-error event includes that monitor call's cost. | Integration: real prompt route SSE body parsed   | —      |
| V1  | No descendant of `.thread` has computed `overflow-y` `auto`/`scroll` **and** `scrollHeight > clientHeight`. A wheel over a long tool output scrolls the thread.                                                                                                                                                                                                                                                                                              | Browser: evaluate on a real run + manual wheel   | —      |
| V2  | At bottom, a new event keeps the thread pinned. Scrolled up more than 48px, new events don't change `scrollTop`. Sending scrolls to bottom.                                                                                                                                                                                                                                                                                                                  | Browser on a real run (cheapest model)           | —      |
| V3  | `groupTurns` cases: multi-call turn; blocked call; monitor error with unrun remainder; invalid-args tool without monitor stays standalone; monitor without `command`; partially reviewed turn shows remainder; zero calls falls back.                                                                                                                                                                                                                        | Unit test (dependency-free)                      | —      |
| V4  | Rendered agent entry shows command → output pairs in order, the remainder `pre`, and no standalone TOOL OUTPUT for grouped calls. ForkPreview shows the selected turn without its outputs.                                                                                                                                                                                                                                                                   | SSR tests (`tests/transcript.test.ts`) + browser | —      |
| V5  | Copy/Fork are in the agent header and add no extra row; still labelled and keyboard reachable; Copy and Fork still work.                                                                                                                                                                                                                                                                                                                                     | SSR test + browser                               | —      |
| G   | `npm run check`, `npm run test:integration`, coverage pass.                                                                                                                                                                                                                                                                                                                                                                                                  | Gates                                            | —      |

## Steps

1. Independent plan verification: done, APPROVE WITH CHANGES. B1–B3 and N1–N6 are folded in above; N7 is answered by using the cheapest model for browser QA.
2. Developer: RED tests first (L1 integration, V3 unit, V4/V5 SSR), then implement, then GREEN.
3. Lead: rerun gates and browser QA (agent-browser, headed fresh session, localhost:3002).
4. Independent full review, at most one corrective cycle. No commit, push or merge without authorization.

## Actual verification evidence

- **L1 RED:** "no billing frame after user event". **GREEN:** exact cumulative frames (0,0) → (40,0) → (40,13) → (40,13) → (80,13); final frame equals `done`; the monitor-error frame includes the monitor cost.
- **V3/V4/V5:** `groupTurns` unit tests (8) and SSR tests, RED (missing export) then GREEN.
- **V1, browser:** no descendant of `.thread` is a vertical scroller with overflow.
- **V2, live guest run:**
  - opening a run lands at the bottom;
  - sending while scrolled up 400px jumps to the bottom;
  - while pinned, it follows at 0px from the bottom;
  - while scrolled up, the position is unchanged as 3 entries arrive.
  - Smooth `scrollTo` never progressed in headless Chrome, so scrolling is now always instant.
- **Layout redesign (user request after this plan):**
  - top run bar: run id, model, turns, collapsible hidden system-prompt editor with an unsaved marker;
  - one-row composer;
  - long output collapses after 12 lines (SSR test, mutation-checked);
  - mobile bar compacts; the select keeps its accessible name "MODEL" at 390px.
  - Screenshotted at 1440, 820 and 390.
- **Lead gates:** check 59/59; coverage pass; integration 43/43 (59.4 s).
- **Independent review:** changes required (P1 mobile label, P2 index and scroll quirks, P3s); one corrective cycle; re-review APPROVED.
- **Not run:** `npm run build`, live smoke.
