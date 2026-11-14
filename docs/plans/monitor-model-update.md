# Monitor model configuration update

Worktree: `/Users/jonathan/Code/ctf/.worktrees/persistent-run-sessions`.
Branch: `feature/persistent-run-sessions`.
Baseline: `4144c1f`. Preserve pre-existing edits in `lib/inference.ts` and `docs/plans/live-monitor-smoke-repair.md`. Use the user's port3002 server for browser work. Do not start another application server.

The user selected investigator `z-ai/glm-5.3` and classifier `jev-1.14.0`, then explicitly selected high reasoning with an 8,192-token output ceiling. Keep the 48,000-byte context ceiling, eight-call limit, 60-second investigation deadline, evidence rules and asynchronous lifecycle unchanged. The subsequent player settings and billing-unit correction are covered below.

The subsequent player-pin instruction supersedes the unchanged-player portion of this scope. Continue under `pinned-player-agent.md` for the dated DeepSeek/low player pin, hidden controls, public enforcement and price routing. That follow-up also repairs the independently confirmed classifier currency-unit conversion error. The published Jev price is unchanged, but the existing microdollar constant was incorrect.

Official metadata checked November 11: https://openrouter.ai/z-ai/glm-5.3 advertises low/high/max reasoning, with reasoning always enabled. https://docs.typesafe.ai/models lists Jev1.14 at the same $0.042 per million input tokens as1.13. The price is unchanged, but its existing conversion to microdollars was wrong and is corrected under P5 in the follow-up plan. Investigator prices continue to come from the provider catalog.

## Acceptance

- M1: Actual monitor inference uses GLM5.3, high reasoning and an 8,192-token ceiling. Player inference follows the later fixed-profile requirement in P1-P4. Verify strict real Pi/transport integrations rather than only equal constants.
- M2: Classifier requests and new-run metadata use Jev1.14. Preserve request schema, calibration questions and published price. Correct its currency units under P5. Test strict request/response boundaries and persisted accounting.
- M3: Bump monitor configuration versions for affected legacy and async review paths. New runs/reviews and current leaderboard selection use the new version. Do not rewrite historical rows or relabel old evaluations.
- M4: Evaluator review metadata and reported investigator model use the investigator pin, not the agent default. Keep synthetic agent-session seeding on the agent default. Verify both actual requests and stored/report metadata.
- M5: Update only affected fixture assumptions, catalog entries, smoke boundaries and accounting assertions. Checks distinguish successful monitor admission from vacuous absence. No investigator prompt, diagnostic schema or filesystem-policy changes. The separately approved follow-up owns public pin enforcement and UI controls.

## Steps

- [x] Inspect callers, baseline and official model/pricing metadata.
- [x] Independently verify this plan and precise scope. GPT-6 Astra with high reasoning approved M1-M5 with the existing-run clarification below.
- [x] Scoped developer updates strict regressions first, records the intended red, applies minimal configuration/caller/fixture changes and verifies scoped integrations.
- [x] Lead runs `npm run check`, offline coverage and real integration coverage. Independent reviewer audits full owned delta and evidence.
- [x] Run one capped live linked-session diagnostic on a disposable database with preserved query results/reasons. Report contract and detection outcomes separately, without retries into success.
- [x] Record results and limitations. No commit, push or deployment is requested in this turn.

Lead owns plan, coordination, final verification and live artifacts. Scoped developer owns model pins in driver/typesafe/control, evaluator metadata fixes, affected smoke boundary and tests. Independent verifier/reviewer is read-only. Every agent uses this checkout and branch, is not alone, and must preserve other changes. No database migration, forced termination of existing runs, historical data rewrite or model-selection framework. Existing historical records remain as stored. Use newly created runs for configuration comparisons.

Proposed version names: legacy `investigator-v3-glm53-jev114`; async `investigator-v5-glm53-jev114-read-detection`. The shared driver uses the explicit investigator model and its selected effort in both runtime construction and provider dispatch. Test and smoke catalogs must include the investigator model independently of the default attacker. All evaluator fields labeled investigator model must report that model.

The independent reviewer approved placing the independent investigator pin in existing pure `lib/policy.ts`, then importing and re-exporting it from the driver to preserve callers. Fixtures can import that pure constant before disposable-pool injection. A static driver import would load database-dependent modules too early. This adds no new configuration module. The later player instruction updates its default and adds the dated snapshot to the historical model list under P1-P4.

Existing open runs keep their stored model/version labels while subsequent reviews execute against the new global model settings. The application does not route investigator models per run. New review rows carry the new investigator/version, but this change does not isolate an already-open run from configuration changes. Compare freshly created runs and do not rewrite historical rows. A separately running monitor worker must reload its process to pick up source configuration changes.

Final evidence is recorded in `pinned-player-agent.md`. Lead checks passed175/175, offline coverage passed175/175 and full integration coverage passed190/190 after a test-only database teardown correction. Independent source review found no P0-P2 issues. The one capped live linked-session diagnostic was unfinished: GLM retrieved the relevant evidence and proposed a positive read, but exceeded the reason length and repeatedly changed quotation marks in a required exact excerpt. It exhausted the call limit with no accepted verdict and no coverage advance. The trace and errors are preserved in `.artifacts/flag-read/model-update-live-report.json`. Spend was$0.023388, held0, and the disposable database was removed. No retry or validator change was made. This run does not establish investigator reliability or deployment readiness.
