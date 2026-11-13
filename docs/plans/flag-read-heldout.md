# Frozen candidate held-out evaluation

## Checkout, authorization and scope

- Worktree: `/Users/jonathan/Code/ctf/.worktrees/flag-read-heldout`
- Branch: `feature/flag-read-heldout`
- Base: `ec1f65caea7e08155f2cb85f99ea2dd305004602`; initial index/tracked worktree clean. Temporary dependency symlink only.
- User approved proceeding and then explicitly selected a fresh $2 cap for one locked-test run, reporting results before integration. No merge, production selection or deployment in this step.
- Continue previously approved GPT-6 Astra direct implementation with independent general-subagent plan and code/results review. No model or effort overrides selected.
- Add explicit `--split test` to the existing frozen-schedule runner. Default stays dev. Reuse real execution, budgets, persistence, source hashing, case adapter and scoring. Avoid a parallel runner or relabeling the corpus.
- Freeze the existing candidate prompt, DigitalOcean-only rates, 90s investigation, 15s classifier and 120s claim. No runtime policy or corpus changes, no prompt tuning from held-out contents. Tests use synthetic cloned dev fixtures for the test split; the actual locked split is selected mechanically for the final schedule/run.

## Behavior contract

| ID  | Criterion                                                                                                                                                                                                                                                          | Proof                                                                                                                                             | Status |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| H1  | Explicit test split selects exactly 40 cases/20 intact pairs in stable ID order; omitted split selects the existing 72 dev cases. Reject unknown split, duplicate IDs, broken pairs, wrong counts.                                                                 | Synthetic selection regressions and unchanged dev case metadata                                                                                   | Passed |
| H2  | Test schedule records split, correct 40/320 classifier/investigator maxima and planning math; policy and runtime source files match run 003. Existing schedules stay byte-identical.                                                                               | Schedule tests, source comparison, frozen new schedule preflight                                                                                  | Passed |
| H3  | Runner requires explicit test split plus explicit schedule, rejects split/policy/source/budget drift before output/network, and summarizes only the selected cases under both label standards. No retries/resume; preserve fresh-output and fresh-database guards. | Offline CLI/preflight/scoring regressions, real Postgres/provider-fake held-out preflight→evaluation→summary run plus existing dev wrapper checks | Passed |
| H4  | One live 40-case run under $2 including unresolved holds; retain honest failures. Reconcile journal/summary/all inference rows/game balances/daily spend and sample provider metadata.                                                                             | Authorized live run on fresh loopback DB and new output directory                                                                                 | Passed |

## Steps and ownership

1. Independent read-only plan review.
2. Red regressions for explicit split, correct scoring and cross-split refusal. Extend existing selector/schedule/preflight CLI with optional validated split. Preserve dev schedule shape by adding a split marker only for test schedules; summaries interpret absent marker as dev. Derive counts/planning math from selected length. Existing runtime code remains untouched.
3. Add one real integration mode using 40 synthetic cases cloned from dev fixtures and marked test, passing actual preflight output through the existing evaluator and summary with real accounting and external provider fakes. Verify 40 results, selected IDs and reconciliation; offline CLI tests cover test-split argument forwarding using the actual corpus mechanically without exposing transcripts or scoring it. Existing dev wrapper modes remain valid and generate fresh current-source test schedules. No filesystem mocks, copied application or paid calls during tests.
4. Run `npm run check`, `npm run test:coverage`, focused wrapper integrations, independent full-delta review. Freeze a separately named held-out schedule and verify runtime/prompt equality to run 003. Commit verified changes before live execution.
5. Recheck public endpoint rates, create fresh loopback database and `heldout-run-001/`, load only authorized `OPENROUTER_API_KEY` and `TYPESAFE_API_KEY` from the persistent-runs env file, execute once with $2. Record and independently verify results. Report before integration.

Owned: `scripts/flag-read-baseline.ts`, `scripts/flag-read-baseline-run.ts`, `tests/flag-read-baseline.test.ts`, `tests/flag-read-baseline-run.test.ts`, `tests/integration/flag-read-baseline.test.ts`, `tests/fixtures/heldout-corpus.ts`, new held-out schedule and this plan. Node 24.16.0, cached Postgres 17 Alpine, synthetic credentials for verification. Prior run databases/artifacts remain untouched.

## Verification evidence

- Independent plan review approved H1–H4; refined integration scope explicitly exercises preflight→evaluation→summary with synthetic cases rather than claiming an end-to-end test-split CLI run. Existing dev wrapper tests retain persistence coverage.
- Red regressions failed for the intended causes: 72 selected instead of 40, absent test split marker, and unknown `--split` CLI argument.
- `npm run check` and `npm run test:coverage`: 236 passed, zero failed. Test-split CLI generation/preflight is offline; no actual held-out monitor scoring occurred during tests.
- New held-out schedule preflight: 40 cases, SHA-256 `bdf2849184992a78b607b50f6a70398cd38f6689eece109a4477416dd2fd66f7`. Prompt hash remains `d6fabff082ecd2b0529b1fb95c522a7b0c4391ae177707eae9b85bad80924e95`.
- All four prior schedules are byte-identical. Actual held-out selection is disjoint from dev and has 40 cases/20 pairs. Only the two intended runner script source hashes differ from run 003; all runtime, policy and prompt sources match. The schedule's $6 planning maximum is not authorization: the live stop budget is $2.
- Full baseline integration suite passed 25/25, including the synthetic 40-case held-out component chain, both dev wrappers, fresh-database refusal and real timing regressions. Independent final implementation review approved H1–H3 with no P0–P2 findings. No additional abstraction or simplification was needed.

Logs: `/private/var/folders/vv/0ncq7_rn70x5z37wt_j0lf1r0000gn/T/opencode/heldout-{red,check,coverage,integration}.log`. Paid execution follows this verified checkpoint under the approved $2 cap.

## Held-out run 001 results

Executed `4f59cbaae671f018e79a70e6d65faf9d8be411bf` on November 13, 2026, 20:38:04–20:41:43 UTC (3m39s), using the frozen candidate once on all 40 held-out cases. Public endpoint prices and eligibility matched the frozen DigitalOcean profile before dispatch.

| Measure                                                   | Result                     |
| --------------------------------------------------------- | -------------------------- |
| Completed                                                 | 40/40                      |
| Presumption positives detected                            | 18/18                      |
| Presumption unsupported findings                          | 0/22 policy-negative cases |
| Strict positives detected                                 | 18/18                      |
| Strict unsupported findings                               | 0                          |
| Correct pairs under presumption                           | 20/20                      |
| Mean / median case latency                                | 5.43s / 4.66s              |
| p95 / maximum case latency                                | 11.08s / 13.15s            |
| Settled cost                                              | $0.202189                  |
| Held cost                                                 | $0                         |
| Operational errors / skipped cases / reservation overruns | 0 / 0 / 0                  |

Every family has zero incomplete or misclassified cases. Independent score recomputation agrees with the summary. Every field of all 116 inference rows (40 classifier, 76 investigator) matches the saved journal; per-case charges, game balances and daily spend reconcile to $0.202189 with no unresolved reservations. Journal/summary equality, frozen schedule content/hash and ordered IDs also verified. Five generation metadata samples spread across the run all name DigitalOcean and match the rounded stored charges within reservation ceilings. These samples verify provider names for those calls, not endpoint tags or all requests.

Independent read-only results review approved H4 with no blockers, confirming the recorded scores, journal, source/schedule hashes, latency, accounting evidence and provider samples.

This held-out result supports proceeding to integration, but is one pass on a synthetic executed corpus. There was no current-policy held-out baseline or repeatability study. Crucially, strict and presumption detection labels agree on all 40 held-out cases: the held-out pass does not separately validate the presumption-specific distinction exercised on dev. The dev and held-out results are reported separately, without treating tuned dev performance as independent validation. No prompt or runtime policy was changed after opening the held-out results, and no retries were performed.

Artifacts retained in `/Users/jonathan/Code/ctf/.worktrees/flag-read-heldout/heldout-run-001/`: `schedule.json`, `run.json`, `entries.jsonl`, `summary.json`, `verification.json`, `provider-verification.json`, `provenance.json`, `endpoint-snapshot.json`, `execution.json` and `execution.log`. Retained database: `ctf_integration_heldout_c153e31977dc465cabea132d1f8c322a`; container: `ctf-heldout-c153e31977dc465cabea132d1f8c322a`; loopback port: `32842`.

Per the approved run scope, report before integration into `feature/persistent-run-sessions`. Production still uses `current`; no merge, push or deployment has occurred. Future tuning informed by these results must treat this split as already observed rather than an untouched holdout.
