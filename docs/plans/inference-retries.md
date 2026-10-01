# Tool alias and rate-limit retries

Checkout: `/Users/jonathan/Code/ctf/.worktrees/inference-retries`
Branch: `feature/inference-retries`
Baseline: `cd52427589009c30b576fe9f6adfbad4ac71db15`; initially clean, no staged changes.

## Contract

Fix tool calls first, then retry HTTP 429 inference responses for both agent and monitor. Five attempts means the initial call plus four retries. Wait 1, 2, 4, 8 seconds respectively; honor a valid longer Retry-After (seconds or HTTP date), including the existing diagnostic metadata header where supplied. The request abort/deadline remains authoritative. No model/provider switching, retries for ambiguous network/timeout/usage failures, schema changes, credentials, paid-service calls, or adjacent cleanup.

- A1: Only the exact `game:sprite_exec` alias maps to registered `sprite_exec`. Canonical calls remain unchanged, other names remain unknown, arguments still validate, and monitor block/allow still gate execution. Persist/replay canonical calls.
- A2: 429 followed by success resumes the same logical inference with identical model/messages/tools/max_tokens, no duplicate command or player instruction. Repeated 429 produces exactly five requests and one terminal error; non-429 fails without retry.
- A3: Both roles display rate-limited/retrying, next attempt out of five, and delay through the existing SSE stage and accessible `role=status` UI. Sending stays disabled; Stop remains available. Retry status clears on resume/completion/failure/Stop.
- A4: Abort during backoff or fetch prevents later attempts/command execution. Preserve lease, season and billing admission checks. Known unbilled 429s do not charge; successful usage settles once; ambiguous final failures retain their holds (do not leak a previous attempt's known-unbilled state).

## Implementation and ownership

Lead owns this plan, independent evidence, browser validation and final report. Developer owns the minimal changes to `lib/inference.ts`, `lib/runner.ts`, existing integration/inference/transcript tests and only necessary UI/type files. Not alone: preserve others' changes. Independent verifier/reviewer is read-only.

1. Add failing alias regression in existing real-Postgres/Pi suite; implement exact provider-boundary mapping; prove allowed execution, blocked nonexecution, argument rejection and canonical replay.
2. Add failing 429 scenarios with strict external transport interception; implement bounded abort-aware exponential backoff, existing stage UI callbacks, and safe accounting. Reuse existing status UI instead of creating a new UI system.
3. Lead runs `npm run check`, `npm run test:coverage`, `npm run test:integration`, build as appropriate. Use Node 24 and disposable local Postgres/synthetic credentials only. Timer control may accelerate waits but cannot replace owned retry logic, SQL, Pi or decisions.
4. Inspect retrying presentation in the in-app browser; exercise deterministic retry/stop UI with controlled fixtures, honestly distinguishing presentation fixtures from real backend integration. Use Coldtea QA if running browser e2e; no Playwright/Cypress. No live provider/Sprite/auth email smoke or deployment.
5. Independent full-diff review; one automatic corrective cycle if needed. No merge/push/deploy. Commit only if authorized; keep unmerged worktree.

## Evidence

Pending: independent plan verification, alias red/green, retry red/green, all offline/integration gates, browser inspection and independent review. Live deployment contract checks intentionally unrun (not authorized).

### Progress

- Independent plan verifier (`gpt-6-astra`, high): APPROVED; required correct known-unbilled transitions, lease/season recheck and bounded timer handling.
- Alias regression: intended red (no command execution) then green, recorded in `.artifacts/alias-red.log` and `.artifacts/alias-green.log` (17 tests passed at checkpoint). Expanded alias safety cases are in progress.
- Lead real Next HTTP/SSE check: `.artifacts/inference-qa/check-http.mjs` passed against localhost:3004 with disposable Postgres, real Better Auth/Next routes/Pi, and strict external OpenRouter/Sprite fakes. Both roles recover; identical logical payload, canonical persisted tool, one persisted instruction, $0.000003 settled once across three successful logical inferences, zero pending hold. Client disconnect during Retry-After cancels backoff, releases lease and refunds the known-unbilled fourth inference. No production credentials/service calls.
- Browser inspection pending: shared in-app browser is currently reserved by another concurrent feature; coordinating access. Coldtea paid QA approval requested separately.

### Lead verification

- `npm run check`: PASS, 13/13 offline tests; lint, formatting and typecheck passed (`.artifacts/lead-check.log`).
- `npm run test:coverage`: PASS (`.artifacts/lead-coverage.log`); all owned runtime source included under existing configuration.
- `npm run test:integration`: PASS, 26/26 tests, ~25 seconds (`.artifacts/lead-integration.log`); covers A1/A2/A4 plus both-role stage emission for A3 on real Postgres/Pi with strict external fakes.
- In-app browser localhost:3004 with real Next/Better Auth/Postgres/Pi and strict external fakes: PASS agent retry 2/5 delay1s visible with screenshot, disabled model/composer and available Stop; recovery produced exactly one harmless command/output and cleared status; 60s Retry-After status visible, Stop restored editable composer and persisted stopped event; continuous429 showed attempt5/5 delay8s then one terminal error and cleared status. Monitor retry was proved in real HTTP/SSE and integration tests; its1s browser status elapsed before the observation (not claimed visually observed). Browser released to concurrent feature coordinators; test server stopped.
- Process deviation: retry regressions were added after implementation, not a genuine pre-implementation red checkpoint. Alias red/green was recorded honestly; final retry tests exercise actual logic and observable SQL/UI outcomes.
- Build and independent full-diff review pending. Paid Coldtea QA was not run without approval; no live-service deployment contract smoke, merge, push or deploy. Changes remain uncommitted because no commit authorization was requested/granted.

### Independent review and bounded correction

First full review requested changes on two P2 findings: a cancellation race could strand the hold after receiving a known-unbilled429; the invalid-argument alias fixture was vacuous because its agent counter was not reset. P3: retry failures retained stale prior-attempt diagnostic fields.

One corrective cycle reproduced both defects in `.artifacts/correction-red.log`. Repairing the fixture exposed actual Pi argument coercion (`{command:1}` reached the adapter as `"1"`); the shared hook now checks the original arguments against the same registered schema using the already-installed TypeBox `Value.Check`, before monitor inference/execution. The inference adapter classifies received statuses before its cancellation check and clears diagnostic state before each dispatch. No new schema validator, dependency or alternate execution path was added. The existing exhaustion regression now asserts actual1/2/4/8s dispatch gaps, not only displayed delays.

Developer corrected gates: check13/13, integration27/27, coverage PASS and clean diff check. Lead final gates/re-review pending; no further automatic corrective cycle is authorized by the workflow.

## Final evidence/status

| Criterion | Evidence                                                                                                                                                          | Status                                                        |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| A1        | Exact/canonical/blocked/unknown/invalid alias cases in real Postgres/Pi suite; actual invalid-call red/green; registered-schema check                             | PASS                                                          |
| A2        | Both-role recovery, identical payloads, exactly five attempts, measured1/2/4/8s dispatch gaps, non429 single attempt                                              | PASS                                                          |
| A3        | Actual Next SSE and in-app browser retry/recovery/Stop/exhaustion checks; existing role=status presentation reused                                                | PASS (monitor SSE observed; its1s browser state not captured) |
| A4        | Received429/abort-race zero hold, backoff abort refund, dispatched ambiguous failures retain hold, lease expiration prevents dispatch, successful settlement once | PASS                                                          |

Lead final Node24 gates: `npm run check`13/13, `npm run test:coverage`, `npm run test:integration`27/27 (~25s), `npm run build`, `git diff --check`: all PASS. Raw logs `.artifacts/lead-final-{check,coverage,integration,build}.log`. Build completed with the existing isolated-environment Better Auth database schema-check warning; no shared DB credentials were loaded during build.

Independent full-feature re-review (`gpt-6-astra`, high): APPROVED; no remaining P0–P2 findings; prior P3 diagnostics fixed. Only one corrective cycle was used. No worthwhile further simplification identified: standard-library timers, existing registered schema, existing SSE/status UI and existing integration harness cover scope without new dependencies/components/frameworks.

Local QA server stopped, owned disposable QA database removed, private feature env file restored, duplicate credential copy removed. Primary checkout remains unchanged/clean. Paid Coldtea QA and live deployment-service smoke were not run; no deployment proof claimed.

Implementation and verification are complete. On October 1, 2026, the user authorized committing the changes, merging `feature/inference-retries` into `main`, and cleaning up the feature worktree afterward. The lead will rerun offline/integration gates, commit only the reviewed files and this plan, merge into the clean primary checkout, and remove the worktree only after confirming it is clean, fully merged, and unused by agents or a dev server. Keep the feature branch; no push or deployment is authorized. The final commit ID is reported to the user rather than embedded in its own contract.

Pre-commit revalidation after authorization: `npm run check` PASS (13/13), `npm run test:integration` PASS (27/27). Source matches the independently approved feature delta. Before removing the merged worktree, retain relevant raw gate/red-green logs in the primary checkout's ignored `.artifacts/inference-retries/` directory; do not copy credential files. The feature dev server was stopped and both feature agents have completed their work.
