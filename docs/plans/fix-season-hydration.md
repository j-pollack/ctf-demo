# Fix season-end hydration mismatch

- Checkout: `/Users/jonathan/Code/ctf/.worktrees/fix-season-hydration`
- Branch: `fix/season-hydration`
- Baseline: `b5bc848db89c48d9dda19d464af44f0ee309c430`; clean worktree/index.
- Roles: current high-capability lead; independent verifier/reviewer `gpt-6-astra` high; scoped developer `gpt-6-luna` medium.

## Scope and criteria

Replace locale-dependent season-end text with an explicit UTC format: `Oct 5, 00:00 UTC`. Valid ISO timestamps come from the existing season model. Do not change season selection, refresh, auth, number formatting, or other UI. No dependencies, warning suppression, live services, shared database/credential use, pushes, or deployments. Commit, merge into main, and cleanup were subsequently authorized by the user. Invalid timestamps are outside this change; preserve existing fallback if practical.

- C1: Given `2026-10-05T00:00:00Z`, formatting always produces `Oct 5, 00:00 UTC`, independent of runtime locale punctuation.
- C2: Given other months, padded times, leap-day and offset timestamps crossing a UTC date/year boundary, output has the correct UTC month/day/hour/minute.
- C3: GameUI uses this formatter; a season without an end still displays `Pre-season run`.

## Steps, ownership, checks

1. Independent read-only plan verification before source changes.
2. Developer owns only `lib/season-end.ts`, `app/game-ui.tsx`, and `tests/season-end.test.ts`. Keep the formatter dependency-free for unit testing; reuse the existing formatter name/call site. Add a minimal regression, prove red using the original locale-based implementation, then replace it with fixed UTC components. Lead owns this plan and temporary browser inspection files.
3. Run targeted Node tests, `npm run check`, and `npm run test:coverage` with installed Node 24. Lead reruns/checks raw results.
4. Inspect an offline SSR GameUI preview in the in-app browser using synthetic props, with scripts/effects disabled and no service calls. This proves rendered integration/appearance, not deployed HTTP/auth/game e2e. Direct formatter checks prove the reported locale-punctuation mechanism. No live e2e required for this offline change.
5. Independent full-diff review. No commit unless authorized; leave verified changes in the feature worktree and report that limitation rather than claiming a committed factory delivery.

## Criterion evidence

| Criterion | Check                                                                                                                                                                                                                                                              | Status |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| C1        | Original locale implementation fails the browser-punctuation regression; fixed formatter passes. Raw red: `/tmp/ctf-season-red.log`; green in `/tmp/ctf-season-check.log`.                                                                                         | Passed |
| C2        | Midnight, padded time, leap day, offset crossing UTC date/year boundary, invalid fallback; `tests/season-end.test.ts`.                                                                                                                                             | Passed |
| C3        | `node --import tsx .artifacts/season-preview.ts` asserts actual dated/undated GameUI SSR; in-app browser at `http://127.0.0.1:3003/` shows both expected banners and `PASS: browser formatter matches server season text`, executing the compiled owned formatter. | Passed |
| Gates     | Node 24.16.0 `npm run check` passes all gates and 13 tests; `npm run test:coverage` passes, `lib/season-end.ts` 100% statements/branches/functions/lines. Raw logs `/tmp/ctf-season-check.log` and `/tmp/ctf-season-coverage.log`.                                 | Passed |
| Review    | Independent gpt-6-astra high full-diff review: no findings; C1–C3 satisfied. Reviewer reran targeted Node24 regressions and diff whitespace check.                                                                                                                 | Passed |

Browser preview is offline real GameUI SSR plus browser execution of the real formatter; it does not hydrate GameUI or exercise deployed HTTP/auth/game behavior. Temporary ignored `.artifacts/` fixtures load no environment files or external services. No live smoke/e2e run, no shared credentials/database use. Initial draft-plan formatting failed and was corrected before the passing baseline/feature gates. The preview initially tried the TypeScript 7 JS API (unavailable); switched to already-installed esbuild without adding dependencies. Developer found no useful further simplification. Initial implementation stopped before commits, merges, pushes, deployments, or worktree removals.

Delivery: user authorized committing the verified changes, fast-forward merging into `main`, and removing this feature worktree after it lands. Primary checkout and index were clean before delivery. Preview server stopped after inspection. No push or deployment is authorized. Commit and merge results are reported in the session rather than recording this document’s own commit hash.
