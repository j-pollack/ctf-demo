# Frozen baseline execution connection

Worktree: `/Users/jonathan/Code/ctf/.worktrees/flag-read-baseline-wrapper`
Branch: `feature/flag-read-baseline-wrapper`
Baseline HEAD: `53aa1e4f99de85a1610d99a7e49d09b1819e26f1`; clean index/tree before work. Reusing the registered feature worktree for its next slice. User approved direct implementation with independent available-agent review. Lead: GPT-6 Astra; delegate reasoning selection unavailable, as previously disclosed.

## Scope and acceptance

Connect the existing frozen 72-case dev schedule to `runFlagReadLiveEvaluation`, using the existing adapter once per case and scoring the same outcomes under both standards. This implementation session uses only offline tests and disposable local Postgres with strict provider transport fakes. No paid evaluation, shared database, deployment, merge or push.

- L1: Default/dry-run stays offline. Live requires explicit live flag, positive budget at or below the schedule proposal, existing process credentials and a fresh loopback `ctf_integration_*` database. Validate schedule/corpus/source hashes and runtime policy/limits before DB or provider access. Locked-test selection, changed source, changed order, malformed budget and existing output destination fail closed.
- L2: Execute exactly the scheduled dev cases sequentially, using the existing committed evidence seeder, current policy, high effort and one transport attempt per inference; production defaults remain unchanged. Persist raw entries/traces and inference usage/accounting after each case plus final two-standard/per-family summary. Interrupted/fatal runs retain completed entries and an explicit failed status; no automatic retry/resume.
- L3: Opt-in classifier reservations use the real existing SQL admission/settlement path with conservative byte-based input allowance and small reservation overhead. A dispatched failed/invalid-usage classifier retains its hold; verified usage settles it. Insufficient budget dispatches nothing. Investigator unknown usage retains its existing hold. Settled charges + holds reduce subsequent-case allowance. Stop later dispatch on accounting overrun. Provider pricing/usage overruns are reported, never hidden or clamped; a software admission cap cannot guarantee an external invoice.
- L4: Test using real Postgres/SDK/orchestration, stubbing only provider HTTP: successful admission, multiple cases, insufficient budget, classifier failure/invalid usage, investigator missing usage/timeout, 429 no retry, actual persisted balances and durable artifacts. Existing evaluator behavior remains covered. Unit tests cover offline preflight/drift/budget rejection without services.
- L5: Run targeted integration, `npm run check`, `npm run test:coverage` and focused integration coverage; independent full-delta review approves before completion. Refresh schedule after source changes, preserving all 72 IDs/order/labels. Check public pricing if reachable; label unavailable metadata honestly and return a proposed cap for approval.

## Implementation and ownership

1. Plan review → bounded regressions against existing seams (red before behavior changes).
2. Add opt-in classifier reservation and disable-retry plumbing → integration failures/holds/limits pass.
3. Add live wrapper preflight, runtime source hashing and durable per-case callback → CLI/integration tests.
4. Regenerate schedule, gates, independent review and verified commit.

Owned paths: `scripts/flag-read-baseline*.ts`, `scripts/flag-read-eval{,-live}.ts`, narrow opt-in changes in `lib/monitor-classifier.ts`, `lib/inference.ts`, `lib/investigator-driver.ts`, `lib/flag-read-investigator.ts`; related unit/integration tests, generated schedule, this plan. No unrelated changes. Classifier reservation uses existing generic reservation with a 64-token overhead at the classifier input rate; no schema migration or alternate accounting engine.

## Verification evidence

- L1: offline preflight rejects altered corpus/source/policy/order, invalid or excessive budgets, cross-checkout execution and PostgreSQL query overrides. CLI dry-run validates 72 cases without services.
- L2: real orchestration with strict fake providers completed all 72 scheduled cases once, with durable JSONL entries, trace/inference records and both-standard summary. Existing output is refused; a persistence callback failure stops before the next case. A pre-existing DB schema produces an explicit failed/incomplete artifact.
- L3–L4: disposable Postgres tests cover successful admissions, 2,917-token classifier rounding, classifier failures/unknown usage, investigator missing usage/timeout, 429 single attempt, insufficient/exhausted budgets, unresolved holds and per-call/aggregate overruns. Old evaluator regression also passes.
- L5: corrective `npm run check` and offline coverage passed 226 tests; focused integration coverage passed 16 tests (new bounded suite plus existing evaluator regression). All three review regressions now pass. Independent corrective re-review approved checkpoint `022eb50` with no remaining P0–P2 findings; confirmed source/corpus hashes and unchanged 72-case order/labels.

Independent review found three P2 issues: float round-trip of already-rounded classifier charges, CWD/import checkout mismatch, and pg query-string host overrides. The correction adds exact integer-microdollar settlement (narrow `lib/games.ts` opt-in), rejects runner/CWD mismatch, and rejects query/fragment overrides in the shared `scripts/monitor-investigate-eval.ts` validator. All three regressions failed before their fixes: 268 vs 266 microdollars, cross-checkout exit 0 instead of 1, and missing expected URL rejection. These two additional shared files are in owned scope for the correction.

Raw logs under `/private/var/folders/vv/0ncq7_rn70x5z37wt_j0lf1r0000gn/T/opencode/`: `baseline-live-{red,green,check,coverage,integration-coverage}.log` and `baseline-correction-{unit-red,integration-red}.log`.

Final gate logs: `baseline-correction-{check,coverage,integration-coverage}.log` in that directory. No simplification was justified beyond reusing the existing reservation, seeding, adapter and scoring paths.

## Operator command (not run against paid providers)

From this worktree with Node 24, first run:

```sh
node --import tsx scripts/flag-read-baseline-run.ts --dry-run
```

After explicit budget approval, supply credentials and a fresh empty loopback `CTF_INTEGRATION_DATABASE_URL` in the process environment, then:

```sh
node --import tsx scripts/flag-read-baseline-run.ts --live --budget-usd 10 --output-dir baseline-run-001
```

No `.env.local` is read. The output directory must not exist. The runner preserves the disposable database for inspecting unsettled or in-flight billing; no automatic reconciliation or cleanup is performed. `summary.json` marks incomplete accounting when not all case entries were recorded. SIGINT/SIGTERM save an interrupted summary; an uncatchable kill can leave only the fsynced entry journal and initial run metadata.

Public metadata checked 2026-11-13: GLM-5.3 $0.084/M input and $3.60/M output (OpenRouter catalog); Jev $0.042/M input, free output (Typesafe model docs). The unchanged proposed $10 stop allowance is not an invoice guarantee or a guarantee of completing every case; the allowed maximum output alone would cost $16.9869312. No paid calls were made.
