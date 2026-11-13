# Offline baseline wrapper

Worktree: `/Users/jonathan/Code/ctf/.worktrees/flag-read-baseline-wrapper`
Branch: `feature/flag-read-baseline-wrapper`
Baseline: `50f0c519fcf60f2b91f38b703dacb641a3c30546`; initially clean.

User authorized direct implementation and independent available-agent review.

## Contract

- C1: Offline CLI selects exactly the 72 dev cases (36 complete pairs), sorted by case ID, and refuses invalid splits, duplicate IDs or broken pairs. Locked test cases and played runs are excluded.
- C2: Emit a deterministic schedule with corpus/source hashes, current policy prompt hash, pinned investigator model and reasoning settings, one attempt per case, sequential execution and artifact locations. Adapt using the existing adapter; future evaluation uses the existing live evaluator. No live execution option in this offline deliverable.
- C3: Produce a proposed spending cap with explicit assumptions and request limits, distinguishing a proposed allowance from a guaranteed cost estimate. No network, database, credentials or model calls during planning. Price metadata must carry provenance; unavailable current pricing is reported honestly.
- C4: Offline result summarization reuses both-standard scoring, reports per-family outcomes, incomplete cases, latency and settled/held accounting, preserving raw entries/traces. Reject unknown/duplicate outcomes and measured-truth mismatch.
- C5: Targeted regressions, actual 72-case dry run, `npm run check`, coverage and independent review pass.

## Steps and proof

Inspect evaluator limits and local pricing → implement small planner/CLI and result summarizer with regressions → generate exact schedule → offline gates → independent review. Owned paths: new wrapper, its tests, generated baseline schedule and this plan; minimal package script if needed. No production policy changes, paid execution, deployment, merge or push.

Status: implemented and independently approved; no remaining P0–P2 findings. Reviewer reproduced all 12 source hashes, corpus/prompt hashes and exact 72-case schedule, and checked both passing gate logs.

Plan review corrections: include classifier model and stage-specific request limits, not just investigator calls. Validate result policy/model metadata against the frozen schedule, not merely against other entries. The cap is an operator allowance, not a current-price quotation; current pricing must be refreshed before paid authorization.

## Delivered artifacts and checks

Exact schedule: `evals/flag-read/baseline-schedule.json`. Generate a new destination with:

```sh
node --import tsx scripts/flag-read-baseline.ts --dry-run <new-schedule.json>
```

The CLI refuses overwriting existing artifacts and has no live mode. `summarizeBaseline(corpusText, entries, schedule)` is the offline reporting API; it preserves raw entries/traces and rejects corpus drift and mismatched outcome policy. Future execution can map selected cases through `toFlagReadCase` and pass them to `runFlagReadLiveEvaluation`; this change does not authorize or implement that dispatch.

- C1–C2: generated 72 ordered cases in 36 dev pairs; 72 classifier requests and at most 576 investigator requests. Model `z-ai/glm-5.3`, high effort, current policy; classifier `jev-1.14.0`. Both standards score the same 72 investigations.
- C3: proposed $10 stop allowance (72 × $0.125 + $1 contingency). Current pricing unavailable locally; no price-derived completion estimate is claimed. A future paid runner must verify budget enforcement and refresh pricing before authorization.
- C4: regressions verify missing outcomes, policy mismatch, corpus hash mismatch, duplicate results, truth mismatch, and retained holds on operational errors without model metadata.
- C5: `npm run check` and `npm run test:coverage` passed, 223 tests each. Initial generated JSON formatting failure corrected. No paid calls, network requests, database access or live integration runs. Tests were added alongside implementation; no test-first red run is claimed.

Raw gate logs: `/private/var/folders/vv/0ncq7_rn70x5z37wt_j0lf1r0000gn/T/opencode/baseline-check.log` and `baseline-coverage.log` in the same directory.
