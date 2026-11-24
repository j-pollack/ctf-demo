# Worker memory: dependency dedupe, SQLite stdin, SQL child cap

Worktree: `/Users/jonathan/Code/ctf/.worktrees/worker-memory`, branch `feat/worker-memory`, based on `911043d`. The primary checkout was clean at the start.

## Context

The Fly monitor worker runs at 1 GB. Measurements from a scratch copy of `911043d`:

- The worker module graph loads three copies of `typebox`, about 2,300 files each. Our `package.json` asks for `typebox ^1.3.34`, while `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` pin `1.3.27`. With our pin set to `1.3.27`, the bundled worker's RSS after load fell from about 207 MB to about 182 MB.
- Each `runTranscriptSql` call spawns a Node child, which peaks at 88 MB on a small projection and 170 MB on an 8.5 MB one. `REVIEW_LOOPS = 4` in `scripts/monitor-worker.ts` allows four at once.
- The child reads stdin with `input += chunk` and calls `Buffer.byteLength(input)` after every chunk. Each call flattens the whole accumulated string. The child's RSS after reading 8.5 MB ranged from 62 MB to 110 MB across runs.

## Scope

1. Pin `typebox` to `1.3.27` in `package.json` and update `package-lock.json`.
2. In the SQLite child source in `lib/transcript-query-runtime.ts`, read stdin as Buffers, count bytes per chunk, enforce the existing 12 MiB limit, and decode once at the end.
3. Allow at most 2 SQLite children at once per process. Further calls wait in FIFO order. The 1-second query timeout starts when the child is spawned. An abort while waiting returns the existing cancelled result and never spawns a child. Rules:
   - The existing pre-abort and 8 KiB SQL checks run before a slot is taken.
   - A free slot is taken synchronously, so calls made in one tick are admitted in call order.
   - After a slot is granted, `signal.aborted` is checked again before spawning. An abort there releases the slot and returns cancelled.
   - One `finally` releases the slot and covers everything after acquisition, including `spawn` and `JSON.stringify`. The input is serialized only after acquisition, so queued calls do not hold it.
   - A waiter removes its abort listener when it is granted a slot or aborted. The investigation signal is shared across queries, so leftover listeners would accumulate.

## Non-goals

- Replacing `pi-coding-agent` with `pi-agent-core`. That is a separate plan.
- Reusing one child per investigation, lowering `--max-old-space-size`, or moving queries to `worker_threads`.
- Changing `REVIEW_LOOPS`, the Fly VM size, the 12 MiB limit or the 1-second timeout.
- The duplicate `pi-ai` and `typebox` inside `pi-coding-agent`'s shrinkwrap. Our pin cannot change them.

## Assumptions and tradeoffs

- The cap is a module-level constant of 2, not configuration. One process runs one worker, so a per-process cap bounds the VM. Two keeps queueing short; four loops rarely query at the same instant.
- A queued query has no wait timeout of its own. The caller's abort signal already bounds a review, and every running child is bounded by the 1-second timeout, so the queue always drains.
- The Vercel app also imports this module. The cap applies there per serverless instance, which is harmless.
- `typebox` 1.3.27 is a downgrade from the locked 1.3.34. Our only import is `Value` from `typebox/value`, and every schema it checks is built with pi-ai's `Type`, which is already 1.3.27. The pin is exact, because `^1.3.27` would keep the locked 1.3.34. `npm run typecheck` and the tests are the check.
- The new tests add about 2.5 s to `tests/transcript-query.test.ts`, above the 2 s unit-test target in `docs/verification.md`. Each phase waits on the real 1-second child timeout; faking time would not prove the cap.

## Criteria

| ID  | Given / when / then                                                                                                                                                                                                                                                                       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Given the updated lockfile, when `npm ls typebox` runs, then the top-level `typebox` is 1.3.27 and `@earendil-works/pi-ai` resolves to it without a nested copy.                                                                                                                          |
| D2  | Given the installed tree, when `find node_modules -type d -name typebox -not -path '*/typebox/*'` runs, then it lists two directories, down from three. The remaining nested copy belongs to `pi-coding-agent`'s shrinkwrap.                                                              |
| S1  | Given a projection with one text row of about 13 MB, when queried, then `runTranscriptSql` rejects with `/SQLite query (input\|process) failed/`, as before. Measured on the old code: EPIPE, "input failed".                                                                             |
| S2  | Given a projection of about 10 MB in a few large rows, when queried with `count(*)` and `sum(length(text))`, then it returns the exact values.                                                                                                                                            |
| S3  | Given a generated 8.5 MB input (4,000 rows of 2,000 characters), when the child source runs five times under `/usr/bin/time -l`, then its peak RSS is reported before and after. This is measurement, not a pass/fail gate. Before: 170, 170, 170, 169, 170 MB.                           |
| C1  | Given two queries that run until the timeout and a third `SELECT 1` started at the same moment, when all settle, then both slow queries return the timeout result and the third returns `ok` with its row.                                                                                |
| C2  | In C1, the third query settles no sooner than 900 ms after it was started, which shows it waited for a slot. Both slow queries settle within 1,800 ms, which shows both were admitted together.                                                                                           |
| C3  | Given two slots held by slow queries and a queued `SELECT 1`, when its signal aborts 600 ms after the start, then it returns `{ ok: false, error: "SQL query cancelled." }` within 200 ms of the abort. Before the cap, `SELECT 1` has already returned `ok`, so this fails.              |
| C4  | Given two slots held by slow queries, when a call is made with `AbortSignal.abort()`, then the cancelled result returns within 200 ms without waiting for a slot.                                                                                                                         |
| C5  | C3 and C4 run first in the same test as C1/C2. C2's 1,800 ms bound then shows that the aborted waiter did not leak a slot: with one slot, the second slow query would settle at 2,000 ms or later. Phase 2 starts its queries and its clock only after every phase-1 promise has settled. |
| R1  | The existing tests in `tests/transcript-query.test.ts` pass unchanged. `npm run check` exits 0.                                                                                                                                                                                           |

## Checks

| Criterion | Check                                                                                                                             | Evidence                                                                                                                       |
| --------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| D1        | `npm ls typebox` in the worktree                                                                                                  | Pass. Top-level `typebox@1.3.27`; `pi-ai` and `pi-agent-core` show `deduped`.                                                  |
| D2        | `find node_modules -type d -name typebox -not -path '*/typebox/*'`. Before: 3 directories.                                        | Pass. 2 directories: `node_modules/typebox` and `pi-coding-agent/node_modules/typebox`.                                        |
| S1, S2    | New tests in `tests/transcript-query.test.ts`                                                                                     | Pass on the old stdin code first, then after the rewrite. S1 rejects in about 37 ms, down from about 186 ms.                   |
| S3        | `/usr/bin/time -l` on the extracted child source, before and after                                                                | After: 153 MB in all five runs, down from 170 MB.                                                                              |
| C1–C5     | One new test in `tests/transcript-query.test.ts`: phase 1 is C3 and C4, phase 2 is C1 and C2. Seen failing before the cap exists. | Red on the old code: the queued `SELECT 1` returned `ok` (C3). Green after the cap in 3 consecutive runs, 2,085–2,088 ms each. |
| R1        | Existing tests; `npm run check`                                                                                                   | `npm run check` exit 0; 389 of 389 tests pass.                                                                                 |

## Steps

1. Add the C1–C5 test. Run it and record that it fails because the queued `SELECT 1` returns `ok` (C3) or because the third query settles before 900 ms (C2). Verify: `npx tsx --test tests/transcript-query.test.ts`.
2. Add the slot queue in `runTranscriptSql`: check abort, acquire, spawn, release in `finally`. Verify: the same test file passes.
3. Add the S1/S2 tests and confirm they pass on the old stdin code. Replace the stdin loop: drop `setEncoding`, push Buffers, add `chunk.length` to a byte total, check the limit per chunk, and decode `Buffer.concat(chunks, total)` once. Verify: the test file passes, then measure S3.
4. Pin `typebox`, run `npm install`. Verify: D1, D2, `npm run check`.

Owned files: `package.json`, `package-lock.json`, `lib/transcript-query-runtime.ts`, `tests/transcript-query.test.ts`, this plan.

## Review and limitations

Independent review found no P0–P2 issues. Open P3 items, left out of scope:

- FIFO order has no test. Replacing `shift()` with `pop()` would pass.
- A release that both grants and decrements would not be caught, because phase 2 has one waiter. A second queued call in phase 2 would catch it.
- The concurrency test has about 800 ms of margin, and S2 must finish inside the real 1-second child timeout. A heavily loaded host could fail them, visibly.
- The child keeps `chunks` referenced after decoding, holding up to 12 MiB of external memory for the query.
- Nothing ties the `typebox` pin to Pi's. A Pi upgrade that moves its pin brings a third copy back until ours is updated.
- The post-grant abort re-check is verified by reading, not by a test.

## Refresh, 2026-11-24

The branch was merged with `main` at `6d9344c`, which brings in PRs 35 to 42. Git merged every file without conflicts. On `main`, `lib/transcript-query-runtime.ts` changed only by adding the `sent_at` and `returned_at` columns to the child's `messages` table, which sits beside the stdin and cap changes. The auto-merged `package-lock.json` kept a stale nested `typebox` under `pi-agent-core`, so it was regenerated by running `npm install` on `main`'s lockfile with the pin applied. Compared with `main`, the regenerated lockfile changes the root `typebox` entry and drops the nested copies under `pi-ai` and `pi-agent-core`.

### typebox measurement

Two scratch copies of the merge commit were made outside the repository and installed with `npm ci`. One kept the pin. The other used `main`'s `package.json` and lockfile, which ask for `^1.3.34`. A scratch script imported the five modules that `scripts/monitor-worker.ts` imports, ran three GCs and printed RSS, heap and the files resolved under each `typebox` directory. Each copy ran six times under `node --expose-gc --import tsx` on Node v25.6.0 with synthetic env values. The first run of each was cold and is excluded.

| Tree            | `typebox` dirs installed | `typebox` copies loaded | Files resolved | Heap after GC | RSS after GC, 5 warm runs         |
| --------------- | ------------------------ | ----------------------- | -------------- | ------------- | --------------------------------- |
| `^1.3.34`       | 4                        | 3, 1,712 files          | 2,015          | 31.5 MB       | 149.6, 149.3, 149.7, 148.4, 149.1 |
| `1.3.27` pinned | 2                        | 1, 668 files            | 971            | 23.0 MB       | 127.3, 126.8, 127.0, 128.9, 128.2 |

The pin lowers the median RSS after load by 22 MB and removes two loaded copies, so it stays. Since PR 35 the worker no longer loads `pi-coding-agent`, so its nested copy is installed but not loaded, and the worker now loads one copy instead of the two this plan expected. Node 25.6 differs from the `node:24-slim` image, so these figures compare the two trees and do not predict production RSS.

### Callers of `runTranscriptSql`

`lib/transcript-query.ts` has the only two production calls. Both are inside `createTranscriptInvestigationTools`: the `SELECT 1 AS ready` health check and the `query_transcripts` tool, which runs with `executionMode: "sequential"`. Its only caller is `runFlagReadInvestigation` in `lib/flag-read-investigator.ts`, used by `lib/monitor-worker.ts` and `scripts/flag-read-eval-live.ts`. Decode screening and second looks from PR 40 call models and never call SQL. A worker therefore has at most four SQL calls at once, one per review loop, so at most two wait. A waiter is admitted within one child lifetime, which the 1-second timer bounds. The investigator's deadline is 600 seconds and it is forced to decide with 90 seconds left, so this wait is small against both.

The `signal` passed to the tools combines the review signal, the deadline timeout from `lib/investigator-driver.ts` and the tools' own controller. When it aborts, a queued call returns `SQL query cancelled.` without spawning. A cancelled health check takes the same `onFatal` path that an aborted child took before the cap.

### Gates

All gates ran on the merge commit `1ddf7a4` with this plan edit on top.

| Gate                       | Result                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`            | Exit 0. 522 of 522 tests pass.                                                                                            |
| `npm run test:integration` | Exit 0. 567 of 567 tests pass in 176 s. It had not run for this branch before.                                            |
| `npm run test:coverage`    | Exit 0. 522 of 522 tests pass. All files: 47.25% lines. `lib/transcript-query-runtime.ts`: 98.48% lines, 83.33% branches. |
| `npm run build`            | Exit 0, with the CI dummy values set for every key in `.env.local` so that none of its values were read.                  |
