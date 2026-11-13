# Bounded evaluation provider-price cap

## Checkout and evidence

- Worktree: `/Users/jonathan/Code/ctf/.worktrees/flag-read-provider-price-cap`
- Branch: `fix/flag-read-provider-price-cap`
- Base: `766a815c80e287cbedfc5551a15afc55bfeb290e`
- Created using the repository helper from the candidate checkout. Initial index/tracked tree clean. The candidate's untracked `candidate-run-001/` remains in its original checkout. Temporary dependency symlink uses the existing installation; checks never load the helper-copied private environment file.
- Continue the approved direct-implementation/independent-review fallback: GPT-6 Astra lead; independent available general subagent. No explicit tier or reasoning controls selected. The user approved committing the verified fix and the fresh $2 evaluation after offline verification.
- Intended integration target: `feature/persistent-run-sessions`. The user identified this as the destination for folding in the work later; this checkpoint/run does not merge, push or deploy.

Case 32 of the interrupted candidate reserved 32,087 microdollars but settled 37,960. Catalog prices were $0.084/M input and $3.60/M output; routed Inceptron prices were $1/M and $4.20/M. Native usage (3,553 input, 8,192 output) reproduces the provider's $0.0379594 exactly. Evidence is in the sibling candidate checkout under `candidate-run-001/{comparison,overrun-provider-metadata,provider-pricing}.json`.

[OpenRouter provider routing](https://openrouter.ai/docs/guides/routing/provider-selection#max-price) documents `max_price.prompt/completion` in USD per million tokens, and `request` in USD per request. It filters providers and prevents execution when the price is unavailable. `getModel` stores USD/M; `infer` divides the same rates by 1e6 for reservations. `stopOnReservationOverrun` is currently set only by the investigator driver for `boundedBaseline`.

## Contract

- C1: Given bounded evaluation inference, outgoing `provider.max_price` uses exactly `model.cost.input` as `prompt`, `model.cost.output` as `completion`, and zero `request` (fixed fees are not reserved). Keep `require_parameters: true`. Reuse the trusted `stopOnReservationOverrun` option to bind the pre-dispatch price ceiling to the existing post-settlement guard; no additional option or routing framework.
- C2: Given no provider satisfying the cap, a synthetic OpenRouter HTTP 404 returns an incomplete operational failure, makes one attempt per case, settles that unbilled investigator reservation at zero and releases its hold. No retry without caps or relaxed cap. Existing 429, timeout, unknown-usage and overrun behavior persists. A provider reporting an excessive charge is still settled truthfully and stops subsequent dispatch.
- C3: Without bounded mode, monitor and agent provider routing retain their existing payloads. Model, effort, token limits, prompt, corpus, labels and accounting arithmetic remain intact. This fixes endpoint-rate mismatch, not a guarantee against provider misbilling or token-estimation error.
- C4: Freeze `evals/flag-read/closed-world-presumption-v1-price-capped-schedule.json` after runtime edits. Preserve both earlier schedules byte-for-byte. New schedule retains identical policy, 72 dev cases/order/labels, execution limits and proposed maximum; changed source hashes record routing behavior. Old schedule must fail source-drift preflight in this checkout. Compare with saved baseline as a changed-routing candidate, not a prompt-only controlled experiment.
- C5: Run targeted failing transport regressions before implementation, then `npm run check`, `npm run test:coverage`, focused real-Postgres baseline/evaluator and Sprite integrations, offline schedule preflight, and independent full-delta review. Fakes prove application wiring/accounting, not OpenRouter enforcement. A separately authorized fresh paid run must confirm endpoint/generation prices and settlement before any promotion.

## Surgical steps and ownership

1. Independent plan review → resolve blocking concerns.
2. Extend existing provider fakes for exact fractional price caps and unavailable-provider accounting; assert unchanged default routing → record intended red failures.
3. Add cap at `lib/inference.ts` payload construction, document trusted option semantics → green transport/accounting checks.
4. Generate separately named schedule; point candidate integration at it → dry-run and immutability comparison.
5. Required gates, independent review, then return revised run proposal. No automatic resume, paid requests, merge, push or deployment.

Owned paths: `lib/inference.ts`, `tests/integration/flag-read-baseline.test.ts`, `tests/integration/flag-read-eval.test.ts`, `tests/integration/sprites.test.ts`, the new schedule and this plan. No new abstraction, dependency, database migration or runner option needed.

| Criterion | Proof                                                                                                                 | Status |
| --------- | --------------------------------------------------------------------------------------------------------------------- | ------ |
| C1        | Exact outgoing caps for fractional $0.084/$3.60 and existing $1/$2 catalogs; successful persisted results             | Passed |
| C2        | Unavailable eligible provider, real zero settlement/hold release; existing overrun/unknown-usage/no-retry regressions | Passed |
| C3        | Default evaluator/Sprite agent and monitor payload assertions; full offline gate                                      | Passed |
| C4        | Schedule dry-run, old schedule rejection, byte-identical old schedules, policy/cases/limits comparison                | Passed |
| C5        | Red/green logs, coverage, integrations and read-only review                                                           | Passed |

Prerequisites: Node 24.16.0, installed dependencies, Docker with cached `postgres:17-alpine`. Use repository integration runner to provision/remove its own loopback databases with synthetic credentials; leave retained paid-run database untouched.

## Verification results

- Independent plan review approved C1–C5 before edits. Transport regressions first failed because bounded requests lacked `max_price` (`price-cap-red.log`).
- `npm run check` and `npm run test:coverage` passed 231 tests each. All-source offline coverage: 32.62% lines/statements, 84.95% branches, 52.58% functions; this does not represent integration coverage.
- `npm run test:integration -- tests/integration/flag-read-baseline.test.ts tests/integration/flag-read-eval.test.ts` passed 22 tests, including the 72-case candidate wrapper and fractional-price success/unavailable-provider modes. Assertions cover outgoing payloads, real persisted reservation rates, zero-cost unbilled settlements, held balances, and unchanged overrun/timeout/unknown-usage handling.
- The initial combined baseline/evaluator/Sprite run passed the entire Sprite suite (168 tests including its parent), verifying default agent and monitor routing. Its only failures were two fractional-price test expectations and their parent; those were corrected and passed in the focused rerun. Runtime and Sprite tests were unchanged between runs.
- Initial typecheck found a test-only type annotation attached to the wrong request type; corrected. Fractional fixtures initially expected decimal literals, while `getModel` produces `0.08399999999999999` and `3.5999999999999996` from catalog multiplication. Tests now assert those exact stored rates and their equality to real reservation arithmetic. No runtime rounding or accounting change was introduced. The values round-trip to the original per-token rates when divided by 1e6; live provider threshold interpretation still needs confirmation.
- New schedule offline preflight passed with SHA-256 `4f6c44c375f2fd2db17be48fd460c56b77cd8e80e9761e856025bcd3b61f7678`. Prompt hash remains `d6fabff082ecd2b0529b1fb95c522a7b0c4391ae177707eae9b85bad80924e95`. Only `sources/lib/inference.ts` differs from the previous candidate schedule. Old candidate schedule fails drift preflight before execution.
- Old schedules remain byte-identical: baseline SHA-256 `3deb2296b4989d960be6faa2b5b03dc3346bef678088adb4fd2185fe42e412ad`; interrupted candidate SHA-256 `31645d3919e34170c81d36ebb98cc2910bc0f91427c6e37b1f42db0bc3faa446`.
- Independent full-delta review found no P0–P2 issues and approved C1–C5. No concrete additional simplification was needed. The user authorized the verified checkpoint and paid run.

Raw logs are under `/private/var/folders/vv/0ncq7_rn70x5z37wt_j0lf1r0000gn/T/opencode/`: `price-cap-red.log`, `price-cap-check.log`, `price-cap-coverage.log`, `price-cap-integration.log` (initial mixed result), and `price-cap-focused-green.log`.

## Approved revised run

Commit the verified fix, then run all 72 dev cases afresh with the approved new $2 stop budget, a fresh empty loopback database and a new `candidate-run-002/` directory in this checkout. This $2 is additional authorization; the interrupted run already spent $0.282884. Keep its artifacts and database intact. The saved schedule's $10 maximum remains a validation ceiling, not spending authorization.

After approval and provisioning, use Node 24 with only the two approved provider keys and the new database URL in the process environment:

```sh
node --import tsx scripts/flag-read-baseline-run.ts --live --budget-usd 2 --output-dir candidate-run-002 --strategy closed-world-presumption-v1 --schedule evals/flag-read/closed-world-presumption-v1-price-capped-schedule.json
```

Offline preflight uses `--dry-run` in place of `--live --budget-usd 2 --output-dir candidate-run-002`. No paid call was made for this fix.

For the real-provider contract check, retain catalog/endpoint price snapshots, inspect generation metadata from the capped run, and reconcile all persisted charges/holds against saved entries. Verify eligible provider selection and investigate any rejection/overrun; never relax caps or automatically retry/resume. Compare completed results with the saved baseline, reporting presumption and strict scores, paired-control regressions, incomplete cases, cost and latency. State explicitly that routing changed alongside the candidate prompt relative to the original baseline. Locked tests remain reserved for the final candidate.
