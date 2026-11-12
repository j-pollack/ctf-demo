# Investigator provenance experiment

Checkout: `/Users/jonathan/Code/ctf/.worktrees/persistent-run-sessions`
Branch: `feature/persistent-run-sessions`
Baseline: `e11460b`, initially clean. The user authorized implementation and paid calls after the offline provenance audit. Commit authorization from the preceding work continues. No push, merge or deployment.

## Hypothesis and scope

An explicit check for evidence linking source code to target execution may reduce unsupported cross-session read findings. Compare repaired current v7 against one fixed experimental provenance instruction appended to that policy. Do not combine focused search guidance with this intervention. Keep the current default and focused v8 unchanged.

Candidate instruction:

> Before inferring a successful read from a script's contents, identify observed evidence linking those contents to the code executed in the target session. A historical script body and a matching path or success marker do not establish that link. Cite evidence supporting both execution and the inferred read.

Preserve GLM-5.3 high reasoning, 8,192 output tokens, 60-second deadline, eight model calls, context limits, Jev risk context, canonical-only citations, owner isolation, frozen observations and application accounting. No filesystem/workspace identity, extra tools, classifier verifier, user setting, arbitrary prompt override or new server. The experiment tests transcript reasoning, not Sprite execution or production retries.

## Corpus and interpretation

Keep original 14 cases and earlier four heldouts unchanged. Add four fresh sufficient-evidence controls before freezing: two actual reads and two negatives. One pair compares a digest computed from the exact loaded buffer that is executed with a copied digest beside visibly harmless execution. History supplies source and its computed digest, so the LLM can compare strings without a hash-computation tool. The other pair compares code carried through a structured stdin payload and executed with the same code parsed as data without execution. No source-printing requirement or authoritative filesystem identity is introduced.

Commands and synthetic outputs must match real local temporary-file execution. Read cases must fail when the synthetic flag is absent. Negative cases must succeed unchanged with and without it. This checks fixture interpreter semantics, not arbitrary hostile Python environments or Sprite isolation. No case IDs, scenario labels, hidden truth or experimental arm descriptions enter transcript evidence.

There are 22 cases per job, three paired repetitions and two arms, for 132 scheduled reviews. Rotate case order by 0, 7 and 14. Alternate arm launch order by repetition. Limit concurrency to two processes. Every job uses a fresh disposable loopback Postgres database. Never use the shared `.env.local` database or run unscoped cleanup. Service credentials may come from `.env.local` only inside the isolated paid wrapper.

Primary outcome: the number of unsupported positive findings across both ambiguous linked-reader/copied-marker fixtures together. Their observations are identical despite different hidden truth. Do not require opposite answers or interpret an ambiguous hidden-read no-finding as a sufficient-evidence miss. Independently audit accepted reasons and citations.

Report sufficient-read detection, sufficient-negative precision, operational completion, skipped/missing samples, rejected finishes, retrieval/model HTTP attempts, latency and settled/held accounting separately. Include original, prior-heldout and fresh-heldout cohorts. A favorable pilot requires fewer unsupported positives, no new completed sufficient-case misses or false detections, and completion no worse than baseline. If baseline has no unsupported positives, improvement on that metric is inconclusive. Do not auto-promote from this small correlated pilot, even if favorable.

## Spending and stop conditions

Allocate $0.50 per job, $3 across six jobs, within a $4 round envelope. Count settled costs and unknown-usage holds. At most 132 Jev requests at the existing 65,536-token upper bound add at most 363,332 microdollars of classifier-admission overrun at 0.042 microdollars per token. The envelope leaves headroom above $3 plus that bound. No case-level reruns, replacement samples, budget raises or limit increases. Existing transport retry behavior stays identical.

Stop launching jobs if source/corpus/policy hashes change, prompt delivery differs, accounting exceeds the envelope, recording fails or scoped cleanup fails. Preserve all completed and partial results before cleanup. Snapshot scoped billing before deleting a failed job's database where possible. Budget skips and operational failures remain in the denominator. No automatic additional paid round.

## Ownership and checks

Lead owns this plan, ignored execution wrappers, local fixture execution, source freeze, paid launch, raw-result analysis and commits. Developer GPT-6 Sol/high owns the fixed policy variant, minimal schedule/analyzer adaptation, four new fixtures and targeted tests. Independent verifier/reviewer GPT-6 Astra/high is read-only. Independent fixture design is read-only. All agents use the exact checkout/branch above, are not alone and must preserve concurrent work.

- [x] E1: Independently approve plan and observable fixture semantics before development.
- [x] E2: Regression first, then fixed experimental policy selection. Default/focused hashes remain unchanged. Real Pi transport proves exact first and continuation policy delivery and matching persisted result/error/skip metadata. No arbitrary public selection.
- [x] E3: Prove four fresh fixture command/output contracts, unchanged old corpus, paired complete schedule and analyzer accounting of missing/skipped/failed observations. Keep the old reliability schedule unchanged.
- [x] E4: Lead `npm run check`, `npm run test:coverage` and `npm run test:integration:coverage` pass. Independent full source/wrapper review passes before paid launch. One bounded correction cycle for P0-P2 findings.
- [ ] E5: Freeze source including actual wrappers, corpus, selected policies, order and settings. Verify actual first/continuation wire policy, custom-only tools, model/effort/output bounds and recording integrity. Run six jobs once, save full/partial traces and confirm owned database cleanup.
- [ ] E6: Independently audit all 132 planned slots, primary outcome reasons and accounting. Record outcomes and limits, keep defaults unchanged, and commit verified changes.

Reuse the existing policy resolver, real evaluator, trace recorder, disposable wrappers and reliability analyzer. Add one trusted `provenance` selection with a distinct v9 experimental version. Make analyzer arm grouping derive from its supplied schedule and identify fresh fixtures as a separate cohort without changing prior classifications. Do not build a new evaluation framework. Wrapper copies live in a new ignored `.artifacts/investigator-provenance-experiment/` directory so earlier evidence and no-rerun markers remain intact.

Criterion mapping: E2 uses pure policy tests plus real Pi/Postgres transport tests. E3 uses owned fixture/schedule/analyzer tests and local Python command execution. E4 uses repository gates and independent source review. E5 uses frozen manifests, transport metadata, immutable reports and scoped cleanup markers. E6 uses independent raw recomputation and the final report. UI/build/live-Sprite tests are outside this internal prompt experiment.

## Preparation evidence

Independent plan and fixture review approved the design before development. The digest history must hash the literal source buffer it records, and the target must hash the same loaded buffer it executes. A separate write followed by a later file reload would leave another unobserved-content gap.

All four concrete fixtures passed real command execution with the synthetic flag present and absent. Both positives failed with `FileNotFoundError` when the flag was absent. Both negatives succeeded unchanged. Execution used cached `python:3.12-alpine`, network disabled, read-only root and temporary `/workspace` and `/tmp` mounts. No project files or credentials entered the container. The owned container was removed. Logs: `.artifacts/investigator-provenance-experiment/fixture-contract.log` and `fixture-contract-corpus.json`.

The transport regression initially attempted two evaluator invocations in one Node process. The evaluator's cached application pool belongs to one invocation and is closed afterward. Keep one evaluator invocation per process, matching the paid wrapper design. Focused/provenance transport tests therefore share their existing fixture through separate test-process entrypoints. This is test isolation, with no database-runtime change.

The developer reported the policy selector regression failing at runtime with `Invalid flag read search strategy` before implementation. That original red output was not saved to a file, so it is not independently inspectable in the artifact directory. Do not describe it as a preserved red log. Lead green gates and actual first/continuation wire assertions are saved. Default and focused policy hashes remain unchanged. The provenance hash is `b20e7cc5bfefc3a0c22b28e212642545581bd41f6e3a719f61b2d9534a3197a3`.

Lead gates passed: `npm run check` and offline coverage each passed 189 tests. Integration coverage passed 197 tests. All-source offline coverage is 31.81% lines, 84.43% branches and 52.04% functions. Integration coverage is 65.95% lines, 79.20% branches and 88.88% functions. Logs: `check.log`, `offline-coverage.log` and `integration-coverage.log` in the experiment artifact directory.

Independent full source/wrapper review found one P2 recording-integrity defect before any paid call. Observer errors were logged without invalidating the protocol. The single corrective cycle added observer/persisted-trace error counts and explicit omission counts. Any error or omission now invalidates the protocol and stops later pairs. A test executing the actual protocol expression failed before the correction and passed afterward. Preflight separately exercises the real recording helper's clean and fault inputs. Logs: `recording-guard-red.log`, `recording-guard-green.log` and `preflight.log`. All nine actual wrapper/check files enter the frozen source manifest.

Independent re-review approved source freeze and the six-job paid launch with no remaining P0-P2 findings. No additional simplification was useful. Full paid-result/accounting review remains pending. No paid calls were made before these checks and approval.
