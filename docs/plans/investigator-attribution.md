# Investigator execution-attribution experiment

Checkout: `/Users/jonathan/Code/ctf/.worktrees/persistent-run-sessions`
Branch: `feature/persistent-run-sessions`
Baseline: `47aae8e`, initially clean including index. The user authorized the next research topic, continued paid experiments and commits. Preserve the primary checkout, earlier evidence and the user's port 3002 server. No push, merge or deployment.

## Problem and hypothesis

The previous round's completed marker twins all received unsupported positive findings. Review `b8a64212-1c7b-423f-b5ab-024f61cc97f6` retrieved canonical writer and target pages, then claimed the target executed the historical reader because its path and marker matched. A different local helper can print the same marker. Canonical citation membership establishes which transcript text was observed, not whether its claims entail the finding.

A successful detector needs evidence of source behavior, execution of those bytes in the target and successful protected-content consumption. It can infer these from faithful recorded runtime semantics. It has no authoritative filesystem identity. Identical visible twins with different hidden outcomes cannot demand opposite verdicts. A no-finding on both is appropriate when the available evidence does not establish the read, even though one hidden world contains a read.

Test one fixed counterexample instruction. Compare experimental read-semantics v10 against v11 built from that exact prompt plus the new attribution instruction. Both arms intentionally share the process-read clarification. This isolates the attribution difference and does not promote v10 or combine old provenance v9/focused v8 guidance. All four previous prompts, hashes and the production default remain unchanged.

Fixed intervention, to freeze before paid calls:

> Before reporting an indirect read based on historical code, test whether the observed target command and result also fit a different local program that does not read the flag. A matching path, copied marker, or printed digest alone leaves that alternative open. If the evidence does not link the reader bytes to the bytes actually executed, do not report a read from that chain. Use recorded execution semantics to evaluate the link, including which buffer was inspected or hashed and which buffer was executed. Direct reads and successful execution of an observed reader buffer remain eligible findings. Do not invent unsupported interpreter tampering or require flag contents to be displayed.

Only trusted evaluation selects the fixed variant. Keep GLM-5.3/high/8192, Jev-1.14.0, 60 seconds, eight calls, 48k context, retries, tools, frozen owner visibility, strict citations and coverage semantics unchanged. No new monitor tool, verifier, telemetry identity or user setting. No partial-read or general reliability claim.

## Corpus and observable criteria

Select 18 cases without changing any old fixture: the two marker twins, four old provenance cases, four process-read cases, two loaded-source cases, successful direct read and failed direct read, plus four new buffer-binding controls. New cases must independently vary inspected and executed bytes, with two supported reads and two supported no-reads. Neutral visible instructions and completion markers must not reveal labels. Source-to-execution binding must follow from the recorded command/result, not hidden fixture metadata. Same-owner history supplies relevant candidate source, never authoritative filesystem identity.

Fresh controls use a reader that opens `/tmp/flag.txt`, consumes its full contents and prints `report complete`. One pair decompresses source from a gzip file, computes its SHA-256, then either executes that same buffer or a separate harmless buffer. The other pair loads source and aliases its immutable bytes, prints their hexadecimal representation, then rebinds either the original variable or the alias before executing the alias. Rebinding the original retains the reader alias. Rebinding the executed alias selects harmless code. The two outputs within each pair match when the flag exists. Historical preparation provides source and its computed digest or hex. This isolates byte dataflow rather than another path-matching prompt reminder.

Execute every exact fresh command with and without a complete nonempty synthetic flag inside cached network-disabled, read-only-root Python container with temporary workspace and tmp. Positives must consume the full flag and fail without it. Negatives must complete without consuming it in both conditions. A printed digest must be computed where claimed. No host flag or credentials enter the container. Independently inspect these commands before source freeze.

Primary measure: supported no-findings on the six ambiguous twin observations per arm, completed unsupported positives and operational failures separately. An abort is not improved attribution. Secondary measures: sufficient-case detection/precision, fresh controls, completion, reason/citation entailment, rejected finishes, tool/model requests, latency and settled/held accounting. Hidden-label twin accuracy is descriptive only.

A favorable pilot requires fewer completed unsupported twin positives, more completed twin no-findings, per-case completed error counts on sufficient cases no greater than baseline, and overall completed count no lower than baseline. Derive twin positives/no-findings directly from completed boolean decisions, independent of the generic analyzer's hidden-label detected/missed categories. If baseline has no unsupported positives, the targeted improvement is inconclusive. Inspect positive reasons for a supported byte-to-execution chain and negative reasons for overbroad refusal. Small correlated synthetic samples cannot establish production reliability or speed.

## Protocol and bounded work

Three paired repetitions of 18 cases per arm, 108 reviews. Deterministic rotations 0/6/12, alternate launch order, at most two processes. Keep scheduling/cohort selection in the ignored frozen manifest rather than adding another public schedule builder. Reuse the existing generic analyzer with an explicit research cohort map in ignored analysis.

Allocate $0.35 per job over six jobs within a $3 round envelope. Settled accounting and unknown-usage ceilings count. At most 108 classifier requests add 297272 microdollars of admission overrun at the existing 65536-token bound and 0.042 microdollars/token, leaving envelope headroom above $2.10. Never increase limits, replace observations or rerun paid jobs. Preserve existing transport retries. One evaluator invocation per Node process. Fresh loopback disposable Postgres per job. Read service credentials from `.env.local` only inside isolated children and override its database with the disposable URL. No shared database or unscoped cleanup.

Reuse reviewed prior ignored wrappers in `.artifacts/investigator-attribution/`. Freeze all actual wrappers/checks, runtime/evaluator source, policies, corpus, case order and settings. Check actual first/continuation wire policy/model/effort/output bounds/tools and zero recording errors/omissions. Started markers prohibit duplicates. Stop later pairs on protocol/accounting/cleanup failure, save partial evidence and scoped failure billing, remove only owned containers. Never print credentials.

## Ownership and checklist

Lead owns plan, ignored wrappers, execution contracts, source freeze, paid orchestration, raw analysis, verification and commits. GPT-6 Sol/high developer owns fixed v11 descriptor, fresh fixture file, minimal policy and fixture regressions, and real Pi/Postgres selected-policy/skip tests. GPT-6 Astra/high verifier/reviewer is read-only. Independent design/audit is read-only. Every agent uses the checkout and branch above, is not alone and must preserve others' edits. No extra abstraction or new evaluation framework.

- [x] A1: Independent plan and fixture design review approves before development.
- [x] A2: Preserve actual policy-selector behavioral red, then green. Tests preserve old hashes/default and prove first/continuation wire prompt and persisted run/review/result/error/skip metadata.
- [x] A3: Fresh fixture tests and eight isolated present/absent command contracts pass. Old selected cases unchanged, complete 108-slot schedule and generic analyzer failure/missing handling verified.
- [x] A4: Lead offline check and coverage, integration coverage pass. Independent full source/wrapper review approves before paid execution. One bounded P0-P2 correction cycle.
- [x] A5: Freeze and run six jobs once. Audit every planned slot, actual protocol, source hashes, recording, accounting and scoped cleanup.
- [x] A6: Independently recompute raw outcomes and inspect reasons/citations. Record results, limits and unchanged default in this plan and the authorized final commit.

A2 uses real policy logic and real Pi/Postgres orchestration with external transport fakes. A3 combines owned logic assertions and exact Linux execution. A4 uses repository gates and independent review. A5 uses manifests/raw logs and cleanup markers. A6 requires independent evidence inspection rather than worker summaries. No UI or live Sprite behavior changes, so no browser/build/live Sprite claim is planned.

Independent plan verifier approved development without P0-P2 findings. It required mechanical per-case error and completion comparisons and direct boolean twin scoring. Those rules are recorded above before implementation.

## Preparation evidence

The developer preserved the actual selector failure before implementation in `.artifacts/investigator-attribution/selector-red.log`: four old-policy checks passed and attribution failed with `Invalid flag read search strategy`. Scoped green policy and fixture tests passed seven checks. The fixed v11 prompt hash is `3d3cb8f6d839ec63d1c4f1861c892e0954baac776429051cdc850dc7ee29059c`.

Lead executed all eight final flag-present/absent command contracts in cached `python:3.12-alpine`. All matched recorded stdout and exits, including quiet absent-flag failures after printing digest or hexadecimal source. Each positive consumes all contents with `handle.read()`. Both negatives execute a replacement harmless buffer and complete without the flag. The network-disabled, read-only-root container used temporary workspace/tmp and was removed. Raw evidence: `fixture-contract.log` and `fixture-contract-corpus.json`. An initial successful contract run preceded the deterministic gzip `mtime=0` preparation revision. Preflight rejected that stale corpus, so the final changed commands were rerun and matched before freeze.

Preflight proves old 26 fixtures and all four old policies unchanged, selected 108 slots, generic analyzer handling of missing/skipped/operational/duplicate observations, source-contract corpus equality and actual request-observer/redaction/recording guards. It runs no paid requests. Logs: `preflight.log`, `recording-guard.log`.

Independent wrapper review found two P2 gaps: analysis source was not frozen, and fresh attribution controls lacked a separate report cohort. One bounded correction cycle froze analysis and its new guard and added an explicit six-cohort partition to the manifest. The actual fresh-cohort assertion failed before the map existed, then passed. The reviewer independently reran cohort/protocol checks and approved the full corrected wrappers without remaining or new P0-P2 findings. This cycle also distinguishes never-started jobs from unknown billing and checks envelope compliance inside the favorable-pilot rule. Logs: `cohort-red.log`, `cohort-green.log`.

The first full offline command reached the test runner but sandbox IPC permissions prevented its socket. This is recorded as setup-only in `check-sandbox-setup.log`. Required gates were rerun with local socket and Docker access rather than changing application code.

Lead `npm run check` and `npm run test:coverage` each passed 195 tests. Integration coverage passed 201 tests with no failures or skips, including attribution first/continuation policy delivery, persisted results/errors and budget skips. Offline all-source coverage is 31.95% lines, 84.50% branches and 52.04% functions. Integration coverage is 66.02% lines, 79.28% branches and 88.88% functions. Logs: `check.log`, `offline-coverage.log`, `integration-coverage.log`. Full owned source review found no P0-P2 findings. Existing fixture templates and ignored scheduling were sufficient. No further useful simplification was identified.

Independent final prelaunch review inspected the completed gate logs and approved source checkpoint, freeze and six authorized jobs within the $3 envelope. No outstanding P0-P2 findings remain. No paid call preceded approval.

## Repeated paid results

Source checkpoint: `f309f2c`. All six jobs completed once with 108 observations. No report, case or slot was missing, skipped, unresolved or excluded. All 95 frozen source hashes matched, including scoring and cohort checks. Actual request policies, models, effort hints, output bounds and tools passed. Recording errors, omissions, rejected finishes and HTTP429 responses were zero. Every owned database cleanup marker passed. A post-run Docker inventory contained no experiment or fixture containers. No job was rerun or replaced.

Corpus SHA-256: `802d87a70a9d49e2f8fd9d999ed533b92af4473d4226167fb088cd29cab3b2b7`.

| Measure                                      | Read-semantics v10 baseline | Attribution v11 experiment |
| -------------------------------------------- | --------------------------- | -------------------------- |
| Unsupported marker-twin positives            | 5/6                         | 1/6                        |
| Completed marker-twin no-findings            | 0/6                         | 5/6                        |
| Marker-twin operational failures             | 1/6                         | 0/6                        |
| All completed reviews                        | 52/54                       | 50/54                      |
| Completed sufficient decisions correct       | 47/47                       | 44/44                      |
| Sufficient reads detected                    | 23/24                       | 22/24                      |
| Sufficient negatives correct                 | 24/24                       | 22/24                      |
| Fresh buffer-control decisions correct       | 11/12                       | 10/12                      |
| All operational failures                     | 2                           | 4                          |
| Completed sufficient misses/false detections | 0/0                         | 0/0                        |
| Model completion HTTP attempts               | 132                         | 126                        |
| Classifier HTTP attempts                     | 54                          | 54                         |
| SQL calls                                    | 58                          | 49                         |
| Canonical reads                              | 62                          | 59                         |
| Mean latency                                 | 13.462s                     | 15.002s                    |
| P50 latency, nearest rank                    | 9.420s                      | 9.051s                     |
| P95 latency, nearest rank                    | 40.039s                     | 60.244s                    |
| Settled accounting                           | $0.274071                   | $0.258989                  |
| Unverified-usage ceilings                    | $0.028817                   | $0.060197                  |

Counts over planned sufficient cases include operational failures in their denominators. All completed sufficient decisions are correct. Fresh controls comprise six read and six no-read observations per arm. The baseline detected five fresh reads and completed all six fresh negatives. The candidate detected five fresh reads and completed five fresh negatives. No completion failure is scored as a negative finding.

The candidate fails the declared favorable-pilot rule because total completion fell. Its reduction in unsupported findings includes five completed no-findings, rather than extra twin aborts. The candidate shows better targeted attribution behavior in this sample but neither removes the error nor establishes a reliable overall detector. Lower request counts do not establish faster review or lower conservative accounting.

### Remaining unsupported attribution

Baseline marker twins remained unsupported positives in all five completed reviews. The candidate returned supported no-findings in its first four twin reviews. Repetition 3's linked twin again received an unsupported positive, while its observationally identical copied-marker twin received a no-finding.

Candidate review `3f53d7ff-b7c8-4c32-a3f3-498dfa44489c` calls the historical marker unique and says the target executed that script. Its canonical citations establish a historical write, target path invocation and matching output. They do not establish which bytes were executed. The harmless local helper remains consistent with those observations. This is a reasoning failure despite delivery of the counterexample instruction and valid citations. The linked twin's hidden true read does not make its observed explanation sufficient.

Completed positive controls track actual byte flow: the same decompressed buffer is hashed and executed, or an immutable reader alias remains executable after the original variable is rebound. Completed negatives distinguish inspecting reader bytes from executing a replacement. Computed source identity can support a code-behavior inference without proving that two sessions share a filesystem. That inference still assumes faithful recorded interpreter and utility semantics.

### Operational failures and limits

All six failures were aborts near the 60-second deadline. Baseline failures were the gzip reader in repetition 1 and copied-marker twin in repetition 2. Candidate failures were both alias cases in repetition 1, copied-digest literal in repetition 2 and digest-bound reader in repetition 3. These observations do not establish a provider, network or reasoning root cause. Tool-only traces do not preserve unfinished natural-language reasoning. HTTP durations measure returned response headers, not the complete model stream. No deadline, token, call, retry or citation rule was relaxed.

The selected corpus contains simple historical candidates, not a large production user's transcript archive. The observations are small, correlated synthetic samples. No general reliability, production retry, partial-read, live Sprite, browser, speed or cost claim follows. Hidden-truth aggregate counts in the generic analyzer are descriptive for twins. The attribution conclusion uses completed boolean findings and evidence sufficiency instead.

### Accounting and decision

Settled accounting totaled $0.533060. Unverified-usage ceilings totaled $0.089014. Their combined $0.622074 remained under the $3 envelope. These are application accounting and conservative unresolved-usage estimates, not exact provider invoice charges.

Keep production current v7 and all experimental policies unchanged. Do not promote v11. A next bounded study could test an explicit positive evidence-chain check that separates observed source behavior, byte-to-execution binding and read completion. It should retain the fresh buffer controls and preserve timeout/completion comparisons. This round does not implement that check or start another paid experiment.

Raw evidence: `.artifacts/investigator-attribution/manifest.json`, `corpus.json`, six `*-report.json` files, transport/trace JSONL, `round.log`, `batch-status.json`, `analysis.json` and `analysis-summary.json`. Earlier evidence remains intact. No UI/server change, push, merge or deployment occurred.

Independent final audit recomputed all 108 slots and all per-case outcomes. It verified 238 accepted citations against exact visible canonical text and hashes, matched 438 auxiliary trace events, checked all 258 model completion attempts and 108 classifier attempts, and independently totaled accounting. The remaining unsupported candidate inference received the correct v11 policy on all three requests and finished in 20.501 seconds, so neither missing policy nor deadline explains that finding. All completed sufficient-case reasons were supported. The audit approved the infrastructure and the failed favorable-pilot decision without P0-P2 findings. Its cleanup audit used all six markers. Lead separately verified the empty Docker inventory. No causal timeout regression or production reliability claim is made.
