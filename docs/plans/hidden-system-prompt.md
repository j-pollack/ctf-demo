# Player-set system prompt hidden from the monitor

- Checkout: `/Users/jonathan/Code/ctf/.worktrees/hidden-system-prompt`
- Branch: `feature/hidden-system-prompt`
- Baseline: `d3f454dadeb53a84a543527e9df28a6751d1aa2f`; primary and feature index/worktree initially clean.
- Roles: lead Claude Opus 5.5 (high); plan verifier and reviewer independent Opus subagents (high, read-only); developer Sonnet subagent (medium).

## Contract

Revision 2 (user, after first implementation): the system prompt lives on the run page, not the New run dialog, and is editable at any time.

The player may write a system prompt for a run. The agent receives it as its system prompt on every turn. The monitor never receives it, so the agent can carry hidden instructions — a simulated misaligned AI. Per-turn player instructions, agent reasoning, tool calls and tool output stay visible to the monitor as today.

- Lives on the run page: an editable "System prompt (hidden from monitor)" textarea in the composer of an active run, above the instruction box. Not disabled while the agent responds. Prefilled from the run's stored value when the displayed run changes; polling must not overwrite an in-progress edit. Ended runs show it read-only when non-empty. The New run dialog has no system-prompt field; new runs start with `''`.
- Saved with each instruction, mirroring the agent-model switch: the prompt request body carries `systemPrompt`, and `claimGame` stores it in the same lease-claiming UPDATE (`undefined` keeps the stored value; a string replaces it; whitespace-only stores `''`). The new value applies from that instruction on. Max 8,192 characters; non-string or longer → 400 before any claim. Optional; `''` keeps today's behavior (`AGENT_PROMPT`).
- Changing it rewrites the replayed system preamble (existing `repairMessages` behavior), so the agent sees only the current prompt, not a history of prompts. A fork inherits its source run's current system prompt.
- Stored in `ctf.games.system_prompt text NOT NULL DEFAULT ''` via additive migration `db/migrations/006-system-prompt.sql`, registered in `scripts/setup.ts` and both integration harnesses. Owner-only via `PublicGame.systemPrompt`; not on the leaderboard.
- One value `agentPrompt = game.system_prompt || AGENT_PROMPT` (`||`: `''` must not reach Pi, which treats empty as "use built-in default") feeds both `systemPromptOverride` and `repairMessages(messages, agentPrompt)`. Pi diffs the loader prompt against replayed sections each turn and patches on mismatch, so both must agree.
- Monitor input is built by a pure `monitorPayload(messages, toolCall)` in `lib/policy.ts`: `{ transcript: messages without any system-role message, proposedToolCall }`, no `agentSystemPrompt`. `scripts/monitor-eval-cases.ts` reuses it. Tool definitions and cwd patches (also system messages) are lost to the monitor; it still sees each proposed call. Eval `suiteHash` changes; old reports are not comparable.
- Fork dialog copy mentions the inherited system prompt.

Non-goals: saving without sending an instruction (an edit not followed by an instruction stays a client-side draft), a history of prompt versions, a new monitor prompt or `MONITOR_VERSION` bump, prompt templates, leaderboard changes.

Assumptions/tradeoffs: the agent's own reasoning can still reveal the hidden instructions to the monitor; that is realistic and intended. Existing runs read `''` and behave as before.

## Criteria and proof

| ID  | Given/when/then                                                                                                                                                                                                                                                                                                                                     | Check                                                                                        | Status |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------ |
| C1  | Given an active run and an instruction sent with alphanumeric marker S, every agent request (first, after a tool result, and in a later instruction that omits `systemPrompt`) has first system content S; persisted row and `messages` preamble are S.                                                                                             | Integration via real prompt route or `claimGame` + `runGame`, real Pi/Postgres               | —      |
| C1b | Given a run on S, when the next instruction carries S2, every later agent request has first system content S2 and contains no S. Sending `""` reverts to `AGENT_PROMPT`.                                                                                                                                                                            | Integration                                                                                  | —      |
| C2  | Across those runs, ≥1 monitor request exists; none contains S or S2, an `agentSystemPrompt` key, or a `role:"system"` transcript entry; each still has the user instruction and proposed call.                                                                                                                                                      | Integration + unit test of `monitorPayload`                                                  | —      |
| C3  | With no system prompt ever set, every agent request's system content is `AGENT_PROMPT` and no request contains "expert coding assistant", across a tool result and a resumed run.                                                                                                                                                                   | Integration + existing message-flow/repair tests                                             | —      |
| C4  | Given `systemPrompt` non-string or > 8,192 chars, the real POST `/api/games/[id]/prompt` returns 400, takes no lease, makes no inference request, and leaves the stored prompt unchanged. POST `/api/games` ignores `systemPrompt` (new run stores `''`).                                                                                           | Integration against the real route handlers                                                  | —      |
| C5  | Given a fork of a run whose current system prompt is S, the child row stores S and its agent request after `runGame` uses S.                                                                                                                                                                                                                        | Integration fork scenario                                                                    | —      |
| C6  | New run dialog has no system-prompt field. Active run page shows an editable, prefilled system-prompt textarea that stays enabled while the agent responds; its value is sent with the next instruction and survives reload after sending; polling doesn't clobber a draft; ended runs show it read-only. `npm run check`, coverage and build pass. | Browser QA (agent-browser, fresh headed Chrome, local dev on vercel-dev Neon branch) + gates | —      |

## Steps and ownership

1. Independent read-only plan verification — done, APPROVE WITH CHANGES; B1–B4 and N2–N6 folded in above.
2. Developer owns: `db/migrations/006-system-prompt.sql`, `scripts/setup.ts`, `lib/runner.ts`, `lib/games.ts`, `lib/types.ts`, `app/api/games/route.ts`, `app/game-ui.tsx` (+ minimal `app/globals.css`), `lib/policy.ts`, `scripts/monitor-eval-cases.ts`, `tests/monitor-eval.test.ts` (index shift + new pinned hash), tests in `tests/game.test.ts` and `tests/integration/{sprites,admin}.test.ts`. `db/schema.sql` untouched (003/005 precedent). Lead owns this plan.
3. (Rev 1, done) Two-phase RED: (a) write C1/C3/C4/C5 assertions, run, record failure (S absent from agent request/row); wire storage + agent prompt → GREEN. (b) write C2 assertions with monitor payload still unfiltered, run, record failure (S leaks via system transcript preamble); add `monitorPayload` filter → GREEN.
4. Verify: `npm run check`, `npm run test:coverage`, `npm run test:integration` (disposable Docker Postgres), build with synthetic env, browser check of dialog + run view.
5. Independent full-feature review; at most one corrective cycle.
6. No commit/merge/push/deploy without authorization.
7. Rev 2: RED for C1b/C4 (prompt route) against the rev-1 code, then move storage from `startGame` to `claimGame`, UI from dialog to composer → GREEN; rerun all gates and browser QA.

## Actual verification evidence

- Plan verified independently: approved with changes; revision 2 re-verified and approved.
- RED recorded before implementation:
  - Rev 1, two phases: S absent from agent request and row, then S leaking to the monitor through the system preamble.
  - Rev 2: prompt route ignoring `systemPrompt`.
  - P2-1: stale draft (`tests/system-draft.test.ts`).
  - Whitespace draft.
- Lead mutation check: removing the `monitorPayload` system filter fails C2.
- Final lead gates:
  - `npm run check` 59/59.
  - `npm run test:coverage` pass.
  - `npm run test:integration` 43/43 at 59.4 s; the parent timeout was raised to 120 s.
  - A pre-existing `Retry-After` HTTP-date timing test flakes under host load ~13; this branch doesn't touch it.
- Browser, real guest and signed-in runs on local dev against the vercel-dev Neon branch (migrations 006/007 applied there, additive):
  - modal has no field; run-page editor stays enabled while responding;
  - draft survives polling; sent prompt persists across reload, unsent draft does not;
  - agent pursued the hidden objective, monitor blocked it.
- Independent review: changes required (P2 stale draft, test headroom, foreign-owner test); one corrective cycle; re-review APPROVED (C1–C6).
- Not run: `npm run build`, live smoke, monitor eval rerun (eval suite hash changed: `7b5e3a9e…` → `7f4cfc1f…`).
- Note: the read-only prompt for ended runs now lives in the run bar (see chat-view plan).
