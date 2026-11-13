# DigitalOcean, 90-second bounded investigations

## Checkout and scope

- Worktree: `/Users/jonathan/Code/ctf/.worktrees/flag-read-digitalocean-90s`
- Branch: `feature/flag-read-digitalocean-90s`
- Base: `cd8edea7f42502a21c5b5d813b354f3f86adb3a0`
- Eventual integration target: `feature/persistent-run-sessions`; no merge or deployment in this step.
- Created through the repository helper. Initial tracked/index state clean. Earlier paid artifacts remain in their original worktrees. Temporary dependency symlink reuses installed packages; checks never load the helper-copied environment file.
- User requested 90 seconds and DigitalOcean after reviewing endpoint statistics. Apply to the existing bounded evaluation path (both current and candidate policy), with a separately named frozen candidate schedule. Production defaults and prior recorded schedules remain reproducible from their original commits.
- Continue user-approved direct implementation by GPT-6 Astra lead plus independent general-subagent plan/diff review; model-tier/effort overrides are not selected. After offline verification the user approved committing this change and running the 72-case candidate with a fresh $2 stop budget (run 003).

Public endpoint inspection for `z-ai/glm-5.3` on November 13, 2026 returned one DigitalOcean endpoint, tag `digitalocean`, pricing $0.91/M input, $2.86/M output, $0.169/M cache read and no fixed request fee. It supports tools, reasoning, max_tokens and reasoning_effort. Freeze conservative uncached input/output ceilings rather than trusting model-wide minimum rates. Endpoint rate increases cause explicit refusal under the ceiling; lower rates remain eligible. No extra runtime endpoint-fetching framework is needed.

## Behavior contract

- D1: Bounded investigators have a 90,000ms whole-investigation deadline; earlier caller deadlines and cancellation still win. Non-bounded investigators retain 60,000ms. The 90-second transport timeout remains subordinate to the whole-investigation signal. Successful work beyond 60s must persist; unfinished work aborts at approximately 90s with unknown usage held, not marked complete.
- D2: Bounded requests pin `provider.only: ["digitalocean"]` and `allow_fallbacks: false`, retain `require_parameters: true`, and cap prompt/completion/request at 0.91/2.86/0. The same frozen input/output rates feed real reservation arithmetic, even when catalog prices differ. Reuse the existing overrun check, single-attempt behavior and settlement logic. No relaxation of pin/caps on 404, 429 or timeouts.
- D3: Use a pure immutable bounded-investigator profile shared by driver, evaluator and schedule builder. Keep catalog model capability/context validation; clone its cost fields for the bounded profile rather than mutate a shared/default model. Add only a trusted provider-endpoint field to the existing inference options. Default agent/monitor payloads and prices remain unchanged.
- D4: The evaluator must hold a real 120,000ms review claim: 15s classifier allowance + 90s investigator + setup/settlement margin. Explicitly enforce the bounded classifier's 15,000ms allowance with a composed signal (the existing classifier has no independent timeout), then pass the claim-wide signal to the investigator. A classifier timeout holds unknown usage and dispatches no investigator. Add a validated optional claim-duration argument to the existing claim operation, preserving its default 90,000ms and all real SQL ownership/expiry fencing. Only bounded evaluation opts into 120s. Do not bypass claims or extend them through test-only SQL.
- D5: Freeze `evals/flag-read/closed-world-presumption-v1-digitalocean-90s-schedule.json`, exposing routing, deadline, claim duration and rate ceilings. Preserve all three existing schedules byte-for-byte. Keep the 72 dev cases/order/labels, prompt, models, high effort, output/call limits and $10 proposal ceiling. Refresh source hashes and price metadata/worst-case planning arithmetic. Old schedules must reject source drift here.
- D6: Required proof: targeted red/green schedule/payload regressions; real-Postgres provider-fake success at 65s and deadline abort at 90s, 15s classifier timeout, real claim duration and balances; unavailable endpoint/no-retry/overrun regressions; default payload assertions; `npm run check`, `npm run test:coverage`, focused baseline/evaluator and job-claim integrations; independent review. Long-duration fixtures select one case each and raise child watchdog to 120s and parent to 360s to cover real waits plus cleanup. Assert elapsed time, persisted review/job outcomes and holds, not only transport call counts. No live quality or provider-enforcement claim from fakes.

## Steps and ownership

1. Read-only independent plan verification before source/test edits.
2. Add changed schedule/routing assertions and 65s/90s integration scenarios; record intended failures.
3. Implement immutable bounded profile, driver deadline/model-rate selection, inference endpoint pin and optional real claim duration; keep all other semantics intact.
4. Freeze new schedule, run focused checks and required gates, review full delta, record evidence. Stop before another paid run.

Owned: new `lib/investigator-evaluation-policy.ts`; `lib/investigator-driver.ts`, `lib/inference.ts`, `lib/monitor-jobs.ts`; `scripts/flag-read-eval-live.ts`, `scripts/flag-read-baseline.ts`; `tests/flag-read-baseline.test.ts`, `tests/flag-read-baseline-run.test.ts`, `tests/monitor-review.test.ts`, `tests/integration/flag-read-baseline.test.ts`, `tests/integration/async-backend.test.ts`; new schedule and this plan. Existing evaluator/Sprite tests protect default routing. No general routing registry, CLI selector, SDK/dependency change, prompt edit or corpus relabeling.

| Criterion | Proof                                                                                                                    | Status |
| --------- | ------------------------------------------------------------------------------------------------------------------------ | ------ |
| D1        | Real 65s completion and 90s abort, preserved earlier deadline/cancellation behavior                                      | Passed |
| D2        | Exact DigitalOcean transport and persisted reservation arithmetic; failures/overrun                                      | Passed |
| D3        | Default evaluator/agent payload checks; unchanged production constants                                                   | Passed |
| D4        | Actual claim_until duration at provider dispatch, invalid/default/custom duration and expiry fencing, classifier timeout | Passed |
| D5        | New CLI dry-run, frozen fields, old schedules unchanged/rejected                                                         | Passed |
| D6        | Offline/coverage/integration logs and independent full-delta review                                                      | Passed |

Use Node 24.16.0 and cached Docker `postgres:17-alpine`. Long-duration checks deliberately use real timers and real SQL/SDK orchestration; do not mock the deadline or leases. Integration runner provisions its own disposable loopback database with synthetic keys and cleans up only that database/container. Retained run 002 has nine unresolved holds and is outside test scope.

## Verification record

- Independent plan review caught the missing classifier-specific deadline and inadequate test watchdogs before implementation. Corrected plan was approved: 15s bounded classifier, separate claim-wide investigator signal, 120s claim, and explicit long-test watchdogs.
- Red schedule test failed on `60000 !== 90000`. Red integrations showed missing DigitalOcean pin/fallback restriction, model-wide rather than endpoint rates, unvalidated duration override, and the old 90s claim. The missing new schedule during red was setup evidence only, not a behavior regression proof.
- `npm run check` and `npm run test:coverage` each passed 233 tests. Coverage across all owned runtime source: 32.98% lines/statements, 84.73% branches, 52.87% functions; integration coverage is not included.
- New schedule CLI dry-run passed. SHA-256: `025a3eec71f7d5db09df49478499d9e2223d2550194d3ac81898cb3a0774225a`. Candidate prompt remains `d6fabff082ecd2b0529b1fb95c522a7b0c4391ae177707eae9b85bad80924e95`.
- All three earlier schedules remain byte-identical. The new schedule preserves cases, policy, corpus, call/output limits and proposed maximum. Only the six intended runtime/seeder/schedule-builder source hashes changed, including the new pure profile. The previous capped schedule rejects on source drift before execution.
- Real-timer baseline integrations passed 24/24, including the 65s successful response, 90s investigation abort, and 15s classifier abort with persisted completion/failure status, claim duration and held balances. The original combined run passed the other 185 tests covering default evaluator behavior, async claim fencing and Sprite orchestration.
- The initial combined run failed two legacy assertions expecting a whole-case skip after unknown usage. DigitalOcean reservations leave enough budget for classification but insufficient funds for another investigator. Corrected tests assert one admitted investigator, retained first-call holds, subsequent persisted budget errors and classifier-only inference rows for both policy prompts. No runtime logic changed to satisfy these assertions. The entire baseline suite then passed; `npm run check` also passed again.
- Independent final review approved D1–D6 with no P0–P2 findings. No further in-scope simplification was needed. Live provider enforcement and detection quality were untested at this checkpoint; subsequent authorized run evidence follows below.

Raw logs: `/private/var/folders/vv/0ncq7_rn70x5z37wt_j0lf1r0000gn/T/opencode/digitalocean-{unit-red,integration-red,check,coverage,integration-green,baseline-green}.log`. `integration-green` contains the initial mixed result; `baseline-green` is the passing corrected rerun. Implementation verification made no paid inference calls. The user subsequently authorized the verified checkpoint and fresh $2 candidate run.

## Operator handoff

Validate the new schedule with Node 24 and installed dependencies:

```sh
node --import tsx scripts/flag-read-baseline-run.ts --dry-run --strategy closed-world-presumption-v1 --schedule evals/flag-read/closed-world-presumption-v1-digitalocean-90s-schedule.json
```

Approved run 003 uses a fresh `candidate-run-003/` output directory and empty loopback database, only the two previously approved provider keys, and a $2 stop budget. Recheck DigitalOcean endpoint eligibility/rates first. Inspect generation metadata for the provider pin, reconcile persisted charges/holds, and retain operational failures rather than silently retrying them. The earlier baseline used a different provider mix and 60s deadline; a prompt-only comparison requires a new current-policy schedule generated under this same DigitalOcean/90s profile. Do not overwrite earlier schedules or artifacts. Integrate into `feature/persistent-run-sessions` only with merge authorization and combined-branch verification.

## Paid run 003 results

Executed commit `87ccede0272a926327dcb6450d703698db7e0086` on November 13, 2026, 20:06:20–20:14:42 UTC (8m22s). All 72 investigations completed, with zero operational errors, skips, unresolved holds or reservation overruns. DigitalOcean endpoint eligibility and the frozen prices were confirmed immediately before execution.

| Measure                               | Original baseline | Capped candidate 002 | DigitalOcean candidate 003 |
| ------------------------------------- | ----------------- | -------------------- | -------------------------- |
| Completed cases                       | 72/72             | 63/72                | 72/72                      |
| Presumption positives detected        | 23/39             | 34/39                | 39/39                      |
| Presumption unsupported findings      | 0                 | 0                    | 0                          |
| Strict positives detected             | 16/29             | 27/29                | 29/29                      |
| Strict unsupported findings           | 7                 | 7                    | 10                         |
| Mean case latency, including failures | 14.61s            | 31.25s               | 6.93s                      |
| Median case latency                   | 12.46s            | 28.41s               | 5.86s                      |
| p95 case latency                      | 30.25s            | 60.31s               | 12.38s                     |
| Settled dollars                       | $0.431805         | $0.331142            | $0.448853                  |
| Unresolved held dollars               | $0                | $0.302821            | $0                         |

Under presumption, run 003 correctly classified all 72 dev cases and all 36 pairs: 16 recovered baseline detections and no regressions. All nine previously incomplete cases now completed. The 63 cases completed in both candidate runs have identical verdicts (34/34 presumption positives, zero unsupported findings). Strict scoring remains separate: its ten unsupported findings are the ten additional positives authorized by the presumption labels, not operational failures.

Mean latency fell 52.5% relative to the original baseline and 77.8% relative to run 002. The slowest case took 26.20s, so this live run never needed the extra deadline allowance; real-timer integration tests establish the 90s behavior. Total spend was 3.95% above baseline. On the 63-case matched completed candidate cohort, spend rose from $0.303191 to $0.376200 (+24.1%), while mean latency fell from 27.10s to 6.55s. Lower endpoint rates than Modal do not establish lower total cost than run 002's different provider/workload, and unresolved run-002 holds are not final charges.

Accounting verification matched every field of all 228 persisted inference rows (72 classifier, 156 investigator) against the case journal. Journal and summary entries, schedule hash/order, per-case charges, aggregate game balances and daily spend agree: $0.448853 settled, $0 held, below the approved $2. Five generation metadata samples spread across the 156 investigator calls all name DigitalOcean and match stored rounded charges within reservation ceilings. This sample verifies provider names for those calls, not endpoint tags or every request.

Independent read-only results review confirmed the recorded metrics, matched-cohort comparison, retained accounting evidence and limitations with no blocking errors.

Artifacts are retained locally under `/Users/jonathan/Code/ctf/.worktrees/flag-read-digitalocean-90s/candidate-run-003/`: `schedule.json`, `run.json`, `entries.jsonl`, `summary.json`, `comparison.json`, `verification.json`, `provenance.json`, `endpoint-snapshot.json`, `provider-verification.json`, `execution.json`, and `execution.log`. Retained database: `ctf_integration_candidate_cd5aafbdf6c04580944065c3ef47638d`; container: `ctf-candidate-cd5aafbdf6c04580944065c3ef47638d`; loopback port: `32840`.

This is one dev-corpus run, not a repeatability or held-out estimate. Prompt, routing and deadline differ from the original baseline; routing and deadline differ from run 002. Production policy remains `current`. Prior paid artifacts and unresolved run-002 holds remain intact. No automatic retry/resume, locked-test evaluation, merge, push or deployment was performed. The intended integration target remains `feature/persistent-run-sessions`, subject to later authorization and combined-branch verification.
