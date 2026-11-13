# Remove player difficulty and expand classifier history

Worktree: `/Users/jonathan/Code/ctf/.worktrees/classifier-context`
Branch: `feature/classifier-context`
Baseline: `6b48e9a9dd184c91c54e7e7c9cbcd75447be4ccb` (includes the completed run-outcome UI fixes).
Initial index/worktree clean. A temporary untracked `node_modules` symlink reuses installed dependencies. Primary checkout remains unchanged.

## Scope and decisions

User requests removing the difficulty selector and giving the classifier as many turns as fit. User explicitly selected normal **32k per-question context**, not optional 262k long context.

- Remove difficulty controls from setup/session settings, client difficulty state/updates, and rules suggesting a selectable difficulty. New browser-created runs use the existing server default Hard scoring profile. Preserve historical values and API compatibility, leaderboard filters and historical labels; no schema/data migration.
- Production classifier history no longer uses 5/10/20 turn limits. Keep an optional explicit window for existing calibration tooling; ordinary runtime uses the newest history that fits its document budget, with truthful omission counts.
- Jev 1.14 documentation specifies 32k tokens per question and 64k per request. No local tokenizer/token-count endpoint is documented. Use an explicitly approximate UTF-8 byte budget (3 bytes/token) with 2,048 tokens of headroom and serialized question overhead reserved. This is not an exact token guarantee: handle the provider's existing `max_tokens_exceeded` error with bounded history reduction. Do not enable the long-context header or add tokenizer/network dependencies.
- Preserve current tool-output clipping, reasoning visibility and hidden-system/submit filtering. Preserve latest instruction and latest visible transcript message; if required content alone cannot fit, fail explicitly rather than silently removing the target or clipping instructions/commands.
- On context overflow, rebuild a smaller newest-history suffix (20% smaller byte budget; at most four reductions), recheck dispatch authorization and abort before each request, and retry only the context call. Stop when no removable history remains; never resend an identical rejected document. This bounded fallback does not guarantee fitting. Preserve successful-call billing through existing orchestration and propagate other errors. No investigator policy, model, enforcement or lifecycle changes.
- Bump `FLAG_READ_MONITOR_VERSION` (and its `ASYNC_MONITOR_VERSION` alias used by new runs and worker reviews) for the changed classifier policy, and verify a newly created run's persisted stamp. Historical database records remain unchanged.

Lead implements directly with independent available-agent review under the previously approved fallback. The tool cannot explicitly select reasoning effort, and model overrides are not user-requested. No paid calls, shared database use, merge, push or deployment.

## Acceptance and proof

| ID  | Observable criterion                                                                                                                                                      | Check / status                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| C1  | Setup and editable/read-only session settings have no difficulty selector or lock guidance; prompt editing, historical agent labels and reasoning guidance remain.        | Passed real React render tests and desktop/mobile browser checks.                                                                 |
| C2  | More than 20 short turns are retained when they fit; only size pressure removes older history in production.                                                              | Passed 40-turn document and actual classifier-request regressions; original 60k cap regression failed before implementation.      |
| C3  | UTF-8 document fits its budget; newest evidence, latest instruction and proposed command survive; omissions and clipping are accurate; oversized mandatory content fails. | Passed boundary, Unicode, overflow and hidden-content tests.                                                                      |
| C4  | Provider overflow shrinks context and retries finitely; successful usage is returned once; abort/auth errors and unrelated failures never turn into success.              | Passed six real classifier/disposable-Postgres scenarios with intercepted Typesafe transport and persisted accounting assertions. |
| C5  | Existing checks and history compatibility remain intact.                                                                                                                  | `npm run check`, `npm run test:coverage`, mandatory targeted integration and independent full-delta review passed.                |

## Implementation steps

1. Review all document/runtime/UI callers, provider limits and repository verification policy; independent read-only plan review before edits.
2. Add failing focused UI/document/overflow regressions, then make the smallest changes in `app/game-ui.tsx`, `lib/monitor-document.ts`, `lib/monitor-classifier.ts` and a narrow context-evaluation helper if needed. Update `lib/control.ts` version stamp and affected tests/tooling only as necessary.
3. Verify actual component rendering in a presentation-only browser fixture; run offline gates and required targeted integration. Record evidence, independently review the full delta, fix meaningful findings, and commit owned verified changes.

## Sources

- https://docs.typesafe.ai/models.md — Jev 1.14 normal/long context limits and long-context tradeoffs, read November 12, 2026.
- https://docs.typesafe.ai/api/errors.md — `max_tokens_exceeded` and request limits.
- https://docs.typesafe.ai/concepts/state.md and https://docs.typesafe.ai/concepts/how-to-build-with-system-one.md — structured state with named fields, narrow questions, and batching independent questions over the same state.
- https://docs.typesafe.ai/model-jaggedness.md — irrelevant context reduces accuracy; state is not treated as hostile by default. Preserve the existing command-only isolation and filtered transcript rather than merging all questions into a large shared state.
- https://docs.typesafe.ai/cookbooks/parallel_questions.md — shared-state batching amortizes input cost. Existing intent/suspicion batching already follows this guidance; no additional classifier round trips or question changes are needed. The context window is a ceiling, not a target to pad.

## Verification evidence

- Independent plan review approved after making real authorization/billing integrations mandatory and naming the actual async version stamp.
- Baseline `npm run check` passed after formatting the new plan. New UI/document regressions failed for the intended selector/history/byte-limit assertions before implementation, then passed.
- Node 24.16.0 `npm run check`: lint, formatting, typecheck and all 232 offline tests passed. `npm run test:coverage`: 232 passed; all-source coverage 33.24% lines/statements, 85.50% branches and 53.50% functions. Coverage is not full-route or classifier-accuracy proof.
- `npm run test:integration -- tests/integration/async-backend.test.ts tests/integration/sprites.test.ts`: 190 tests passed against disposable Postgres with synthetic credentials and intercepted external transports. Covers current new-run version persistence, legacy profiles retaining full fitting history, successful context retry with exactly 3,000 persisted input tokens/126 microdollars, lost-claim/abort/error/exhaustion/pinned-only failures preserving the successful command's 1,000 tokens/42 microdollars, and no command redispatch. Token-limit retries stop after five attempts total; unrelated 503 responses are not retried.
- Mutation proof: disabling context retry made the retry-success, claim-loss, abort and exhaustion regressions fail. Restored implementation before the passing integration gate.
- Initial combined integration runs exposed a teardown race: installed `pg-pool` resolves `end()` after removing clients from its internal list, before socket-close callbacks. Updated this test's cleanup to await actual `remove` callbacks and use non-forced database removal. The combined gate then passed with no post-test asynchronous errors. Initial fixture failures (expected microdollar rounding and old turn-window expectations) were corrected before that gate.
- Browser fixture using real exported components and production CSS passes at 1440×1000 and 390×700: no difficulty controls/text, saved/draft prompts and historical agent labels remain, no horizontal overflow, mobile prompt remains scroll-accessible. Screenshots visually inspected in ignored `.artifacts/classifier-context/`. Presentation-only proof, not authenticated live-route E2E.
- Raw logs: `/private/var/folders/vv/0ncq7_rn70x5z37wt_j0lf1r0000gn/T/opencode/classifier-context-{before,red,focused,check,coverage,integration,retry-red}.log`.
- No live provider calibration or deployment checks run; no empirical classifier-accuracy improvement is claimed.
- Initial final review found one remaining rules sentence telling players to choose Easy. Corrected the guidance to “Press Play, then Start run.” Extracted the existing step list as `RunInstructions` for a real rendered-component regression; it failed on the old wording before the correction. Both offline gates passed after the correction. Independent full-delta re-review approved with no remaining findings.

Plan-review correction: disposable-Postgres classifier integration is mandatory. Exercise real `classifyMonitorTarget` with only Typesafe transport intercepted; invalidate lease/generation or job claim between attempts and assert denied redispatch, assert abort prevents redispatch, command evaluation is not repeated, command usage is persisted even when context ultimately fails, and successful retry usage is charged exactly once. No mocked authorization or accounting. Stop repeated overflow when pinned content alone remains.
