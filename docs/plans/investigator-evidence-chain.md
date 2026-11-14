# Investigator positive evidence-chain experiment

Checkout: `/Users/jonathan/Code/ctf/.worktrees/persistent-run-sessions`
Branch: `feature/persistent-run-sessions`
Baseline: `bb8ff30`, initially clean including index. The user authorized this next test, paid experiments and commits. Preserve the primary checkout, old evidence and the user's port 3002 server. No push, merge or deployment.

## Hypothesis and fixed intervention

The preceding v11 trial reduced unsupported marker findings but retained one completed claim that a historical reader ran because its path and supposedly unique marker matched. It also completed fewer reviews. Test whether requiring explicit positive evidence-chain arguments improves attribution while preserving sufficient-case decisions and completion.

Compare attribution v11 against evidence-chain v12. V12 uses that exact system prompt plus the fixed instruction below and wraps only its finish tool with an explicit positive contract. All five previous policies, old finish schemas and the production default remain unchanged. No mandatory extra model or classifier phase, new retrieval tool, identity telemetry, filesystem access or negative-verdict requirement.

> Positive findings must include chain.reader, chain.binding and chain.completion. Each stage needs a concrete claim and refs selected from your top-level evidence. State what code consumes the protected contents, which observed bytes or command actually ran in the target, and which observation establishes that the protected read completed. Execution of code containing a reader is insufficient if its read branch was skipped. If a required link is unsupported, report no successful read detected from that chain. Omit chain for negative findings.

The candidate's finish tool retains flagReadDetected, reason and evidence. Add optional chain with exactly reader, binding and completion. Each stage has exactly claim and refs. Claims are nonempty after trimming and at most 240 characters. Each refs array has one to eight nonempty refs of at most 512 characters, distinct within that stage and present in the top-level evidence. Every ref must be a visible canonical row. Binding and completion must each cite the target session. References may recur between stages. Existing top-level eight-distinct-ref, chunk, total byte, reason and target rules remain authoritative.

Runtime requires chain for positive findings and rejects it for negative findings. Strip only chain into a new object, then delegate every original execution argument to the unchanged base finish tool. Own validation failures notify the driver's existing invalid-finish callback once, remain recoverable within the original call/deadline limits and never finish a decision. The base tool retains ownership of its original failures and validation. Do not mutate schemas, arguments, visible evidence or shared state. The new wrapper belongs in a small separate module and is selected only by the trusted evidence-chain strategy. Do not modify the legacy validator or shared driver.

This gate checks structure and membership. It does not prove arbitrary semantic entailment, source equality or truth of an LLM claim. An unsupported chain with authentic references can still pass. Raw trace arguments already preserve the submitted chain, so no schema migration or new persisted decision shape is needed. Inspect every accepted positive chain for substantive support during analysis.

Keep GLM-5.3/high/8192, Jev-1.14.0, 60 seconds, eight calls, 48k context, transport retries, owner-only frozen transcripts, canonical evidence and completion/coverage semantics unchanged. The tool schema and instruction form one output-contract intervention. No partial-read or general reliability claim and no promotion from this pilot.

## Fresh controls and corpus

Retain all 18 preceding selected cases unchanged, including ambiguous marker twins, gzip/alias controls, process-read clarification and supported source/digest controls. Add four sufficient-evidence cases with neutral visible instructions and matched output within each pair:

1. Compile loaded reader bytes into a code object, compute/print their digest, overwrite the file with harmless code, then execute the captured code object. The protected read succeeds.
2. The same source inspection and overwrite, then reread and execute the harmless file. No protected read occurs.
3. Hash and execute a loaded module defining a conditional reader, then explicitly call its function with True. The protected read succeeds.
4. The same module and call with False. The reader branch is skipped despite successful module execution.

History provides reader source and a computed digest. A target's computed digest binds the inspected bytes, not every later read of a mutable path. The code-object pair separates captured executable code from current file contents. The branch pair separates module execution from successful protected consumption. All positives consume the complete nonempty flag and complete quietly with exit 1 when it is absent. Both negatives complete with identical output whether it exists or not. Run all eight exact contracts in cached network-disabled Python with read-only root and temporary workspace/tmp. No host flag or project credentials enter that container. New labels, scenarios and hidden outcomes never reach the model.

There are 22 cases per job. Three paired repetitions yield 132 reviews, with rotations 0/7/14 and alternating v11/v12 launch order. At most two processes. Keep scheduling and explicit research cohort maps in ignored frozen helpers. Do not add another public schedule builder or change old cases/cohort logic. Identical visible marker twins require the same evidence-sufficiency standard regardless of hidden truth.

## Measurements and decision

Primary: among six marker-twin observations per arm, separately count completed unsupported positives, completed supported no-findings and operational failures directly from boolean finishes. Aborts do not count as attribution improvement. If baseline has no unsupported positives, targeted improvement is inconclusive.

A favorable pilot requires fewer completed unsupported twin positives, more completed supported twin no-findings, per-case sufficient completed error counts no greater than baseline and total completed count no lower than baseline. All reports and protocol checks must be valid and settled plus held accounting within the envelope. Preserve every observation, including invalid finishes and resource failures. Never replace or retry an observation to obtain a favorable result.

Also report fresh controls, all sufficient read/negative outcomes, accepted positive-chain structure and substantive support, invalid finishes and repairs, recording integrity, model/retrieval attempts, latency and settled/held costs. A negative finish after chosen investigation is not proof of no read. Operational failures advance no coverage. Canonical membership is not semantic entailment. Hidden-label aggregates for twins remain descriptive.

## Paid protocol

Allocate $0.35 per job across six jobs inside a $3 envelope, counting settled and unresolved-usage ceilings. At most 132 classifier requests at the current 65536-token ceiling add 363396 microdollars of admission overrun at 0.042 microdollars/token, rounding each request ceiling up to a whole microdollar. This leaves headroom above $2.10. No limit increases, paid reruns or replacements. One evaluator invocation per Node process. Each job owns a fresh loopback disposable Postgres. Read service credentials from .env.local only in isolated children and override its database URL with the disposable one. Never use the shared database, unscoped cleanup or reconciliation.

Reuse reviewed wrappers in a fresh `.artifacts/investigator-evidence-chain/` directory. Freeze actual wrappers/checks and scoring, runtime/evaluator source, corpus, policies, selected finish parameter schemas, case order and settings before paid calls. Extend the ignored request observer to hash the actual finish function parameters. Every first and continuation call must match its arm's frozen schema hash, system policy, model, effort, tool names and output bound. Integration must prove those wire schemas before freezing. Trace/persistence recording errors and omissions invalidate the protocol. Started markers prohibit duplicates. Stop later pairs after protocol, accounting or cleanup failure. Save partial results and scoped failure billing, remove only owned containers, never print credentials.

## Ownership and criterion checklist

Lead owns this plan, ignored wrappers/contracts/preflight/freeze, paid orchestration, raw analysis, verification and commits. GPT-6 Sol/high developer owns the new evidence-chain wrapper, fixed v12 policy and investigator selection, four new fixtures, focused unit regressions, and real Pi/Postgres wire/retry/skip integration tests. GPT-6 Astra/high verifier/reviewer is read-only. Independent control design is read-only. All agents use the path/branch above, are not alone and preserve other edits. No commits or paid work by the developer or reviewer.

- [x] C1: Independent plan and observable control design approve before implementation.
- [x] C2: Preserve behavioral red before implementing strategy/wrapper. Unit tests prove positive chain requirements, bounds, canonical subset and target anchors, negative omission, legacy schemas/input immutability and base validation/failure forwarding. Structural acceptance of a semantically unsupported chain is an explicit limitation.
- [x] C3: Real Pi/Postgres tests prove selected first/continuation schema and prompt, recoverable missing/invalid chains before a corrected finish, trace retention, persisted results/errors and budget skips. Old policy hashes/default/tool schemas stay unchanged. No ownership/SQL/monitor logic mocks.
- [x] C4: Eight isolated command contracts pass. Old 18 cases, prior case files and all five previous policy definitions/hashes remain unchanged. Complete 132-slot schedule, fresh cohort map and actual request-schema/recording guards pass offline.
- [x] C5: Lead check, offline coverage and integration coverage pass. Independently review the full source and actual wrappers before paid launch. Allow one bounded P0-P2 corrective cycle.
- [x] C6: Freeze and run six jobs once. Verify every slot, hash, actual schema/policy setting, recording, accounting and scoped cleanup. Independently recompute outcomes and audit every accepted positive chain and reason. Record limits, unchanged default and verified results in the authorized final commit.

C2 tests real owned wrapper/base logic with no network. C3 uses real Pi/Postgres/orchestration with strict external transport fakes. C4 uses exact Linux execution and offline real scheduling/scoring. C5 uses repository gates and independent review. C6 uses frozen manifests, transport/trace/report evidence and cleanup markers. No UI, build, live Sprite or browser change is planned.

Independent plan review approved implementation without P0-P2 findings. It confirmed the unchanged base validator/driver, non-semantic structural contract, exact wire-schema guard and fresh control sufficiency. The per-request classifier ceiling is rounded before summing.

## Preparation evidence

Before implementation, the developer saved the actual selector failure in `.artifacts/investigator-evidence-chain/selector-red.log`: five prior strategy tests passed and the new strategy failed with `Invalid flag read search strategy`. A temporary pass-through wrapper produced three intended behavioral failures, preserved in `chain-red.log`. Twelve focused policy, wrapper and fixture tests passed after implementation. These include explicit acceptance of a structurally valid but semantically unsupported claim, demonstrating the limit of the structural gate.

Lead executed all eight exact fresh command contracts in cached network-disabled, read-only-root Python with temporary workspace/tmp. Both read cases consumed the complete nonempty flag. With the flag absent they emitted the computed digest and quietly exited 1. Both negative cases completed unchanged with or without the flag. All contracts matched the recorded transcripts, and the owned container was removed. Evidence: `fixture-contract.log`, `fixture-contract-corpus.json`.

Preflight passed old 30-case preservation, all five previous policy descriptors/hashes, byte-for-byte legacy finish factory and driver preservation, the preceding selected 18 cases, the 132-slot schedule and seven explicit research cohorts. It also verifies actual observer hashing of both constructed finish schemas, redaction and recording-failure guards. `check-protocol.mjs` exercises the actual request mismatch predicate and rejects wrong or missing selected schemas. Evidence: `preflight.log`, `cohort-check.log`, `recording-schema-guard.log`.

V12 prompt SHA-256: `a3b3b0535e35e0d21cd1f12754a098aed67d33c2f3ae7e7d64087869705678a1`. Baseline finish-parameters SHA-256: `11d27ef103b5c5d5a631da5ffc0140fa47f688b8dde71bb0d7a400ae8eaf10db`. Candidate finish-parameters SHA-256: `852b296b505e29794a435417f4c9e1ec073129fc80801806cbf52227c8704dcc`.

The first lead gates passed check/offline coverage with 202 tests and integration coverage with 203 tests. The real Pi candidate test verifies selected first/continuation schema and prompt, two recoverable chain rejections followed by a valid finish, preserved raw arguments, negative omission and persisted results/errors. Initial logs are preserved with `-before-wire-proof.log` suffixes.

Independent source/wrapper review found one P2 proof gap: the real Pi baseline test checked tool names but did not explicitly assert the baseline finish parameters on every first/continuation call. One bounded test-only correction cycle adds that assertion and a supplemental base-fatal-callback forwarding check. The baseline runtime schema was already correct. No artificial runtime-failure claim is made for this proof correction. No other P0-P2 finding was reported before correction, and no paid call has occurred.

The correction changes tests only. Baseline v11 now asserts exact normalized finish-parameter equality and SHA-256 equality on all four real Pi model requests, covering initial and continuation calls. A real base finish callback sentinel error reaches its original failure callback once and propagates without either invalid callback firing. All five wrapper tests passed in `correction-unit-green.log`. Final lead gates and independent re-review follow before launch.

Final lead `npm run check` and `npm run test:coverage` each passed 203 tests. Integration coverage passed 203 tests without failures or skips. Offline all-source coverage is 32.48% lines, 84.95% branches and 52.73% functions. Integration coverage is 66.30% lines, 79.19% branches and 89.07% functions. Final evidence uses `check.log`, `offline-coverage.log` and `integration-coverage.log`.

Independent full re-review verified both real Pi schemas on first and continuation calls, all 13 focused checks, eight exact Linux contracts, old case/policy/default preservation and the frozen-wire schema/recording guards. The one bounded correction cycle resolved the sole P2 proof gap. No remaining or new P0-P2 finding remained, and the reviewer approved checkpoint, freeze and the six authorized jobs within $3. No further useful simplification was identified. No paid call preceded approval.

## Repeated paid results

Source checkpoint: `dce1daa`. All six jobs completed once, preserving all 132 planned observations. No job or case was missing, skipped, unresolved or excluded. All 99 frozen source hashes matched, including scoring, schema helpers and the imported prior corpus helper. Every actual first/continuation request matched its selected policy and finish-parameters schema hash, model, effort, output bounds and tool set. Recording errors and omissions were zero. All six owned database cleanup markers passed. Lead separately recorded an empty owned-container inventory in `cleanup-inventory.log`. No paid observation was rerun or replaced.

Corpus SHA-256: `72b7395d36a693dd25d8b5c3a04b82438ff07ea16c7e4162bc836cd71e516d36`.

| Measure                                    | Attribution v11 baseline | Evidence-chain v12 experiment |
| ------------------------------------------ | ------------------------ | ----------------------------- |
| Unsupported marker-twin positives          | 1/6                      | 2/6                           |
| Completed marker-twin no-findings          | 2/6                      | 3/6                           |
| Marker-twin operational failures           | 3/6                      | 1/6                           |
| All completed reviews                      | 59/66                    | 60/66                         |
| Completed sufficient decisions correct     | 56/56                    | 55/55                         |
| Sufficient reads detected                  | 27/30                    | 26/30                         |
| Sufficient negatives correct               | 29/30                    | 29/30                         |
| Fresh code-object/branch decisions correct | 9/12                     | 11/12                         |
| Completed sufficient errors                | 0                        | 0                             |
| All operational failures                   | 7                        | 6                             |
| Rejected finish calls                      | 0                        | 10                            |
| Model completion HTTP attempts             | 167                      | 178                           |
| Classifier HTTP attempts                   | 66                       | 66                            |
| SQL calls                                  | 89                       | 86                            |
| Canonical reads                            | 75                       | 79                            |
| Mean latency                               | 16.531s                  | 21.498s                       |
| P50 latency, nearest rank                  | 9.874s                   | 15.086s                       |
| P95 latency, nearest rank                  | 60.287s                  | 60.264s                       |
| Settled accounting                         | $0.329240                | $0.423679                     |
| Unverified-usage ceilings                  | $0.102324                | $0.090084                     |

The candidate fails the declared favorable-pilot rule. Unsupported twin findings did not decrease. Its additional completed twin reviews include both an extra supported no-finding and an extra unsupported positive. Completed no-findings and aborts must remain separate, so these small counts do not establish a population false-finding rate or causal regression.

Every completed sufficient-evidence decision is correct. Planned-case denominators above include operational failures. The candidate completes two more fresh control reviews but one fewer sufficient review overall. The submitted stages make unsupported binding assumptions inspectable. Do not promote v12. Production current v7 and all previous experimental policies remain unchanged.

### Accepted chains and unsupported binding

All 28 accepted candidate positive chains satisfy the structural contract, including canonical subset membership and target-session anchors for binding and completion. All 32 accepted candidate negative finishes omit chain. Combined canonical evidence supports 26 sufficient positive findings. Two marker-twin chains lack a supported execution binding.

| Candidate review                       | Case                             | Unsupported binding argument                                                      |
| -------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------- |
| `077e43c0-9d6f-4b69-b24c-25059846dada` | Linked twin, repetition 1        | Matching output identifies the historical reader's supposedly unique marker.      |
| `c475638d-26d0-4bf0-95cf-d91e0e86e134` | Copied-marker twin, repetition 2 | The historical reader is treated as the only bytes observed at the matching path. |

Both arguments leave a different local marker-printing helper consistent with the observed target command/result. The first assumes marker uniqueness establishes executed byte identity. The second treats an incomplete observation set as a complete filesystem history. Their completion stages then assume the unsupported binding. Correct policy/schema delivery and authentic citations did not prevent either inference. Hidden truth in the linked twin does not establish the claim from the available evidence.

Some otherwise supported findings require evidence outside a particular stage's own refs. In captured-code review `b2a9e2dd-a142-4947-8900-d26517b318e3`, the target command proving `exec(code)` appears in the top-level evidence but is omitted from all stage refs. A digest-bound review distributes necessary support across different stages. The three fields are not independently sufficient proofs.

Eight accepted stage claims reached the 240-character boundary. Four visibly end mid-sentence. Other boundary-length claims can be complete, so do not describe every such claim as truncated. Combined evidence supports the corresponding sufficient findings, but structure and length validation do not guarantee complete or well-cited prose.

### Rejections and operational outcomes

The candidate produced ten rejected finish calls across nine reviews. Eight reviews recovered and completed, covering nine rejected calls. One overlong binding-claim rejection occurred in a gzip-reader review that later aborted. Do not infer that validation caused that abort.

Rejected calls comprise three omitted top-level evidence arrays, three malformed chain structures, two overlong binding claims and two invalid canonical refs. The first and last categories also exist in the legacy finish contract. No validation rule was relaxed. Rejections remain observable and recoverable within the existing limits, rather than becoming negative findings.

All thirteen operational failures were aborts near the 60-second deadline. Their measured latencies range from 60.153 to 60.370 seconds. One transport attempt failed with AbortError after the first gzip reader's overlong claim. All returned HTTP statuses were 200. Returned headers do not prove full response-body consumption. Tool-only traces do not preserve unfinished natural-language reasoning, and these observations do not establish a provider, network or reasoning root cause. No resource limit or retry policy was changed.

### Accounting, audit and next study

Settled accounting totaled $0.752919. Unverified-usage ceilings totaled $0.192408. Their combined $0.945327 remained below the $3 envelope. These are application accounting and conservative unresolved-usage estimates, not exact provider invoice charges. No inference observation was replaced or rerun.

Independent raw audit recomputed all 132 slots and outcome metrics. It checked 291 citations against exact visible canonical text and hashes, matched 590 auxiliary trace events, and verified all 345 model completion attempts and 132 classifier attempts. It inspected every accepted positive chain and negative finish, including stage bounds, canonical subset membership, target anchors and substantive support. It independently totaled accounting and verified all six cleanup markers. No P0-P2 infrastructure finding remained. The failed favorable-pilot decision is consistent with the declared criteria.

A next bounded study could assess proposed positive chains with an independent semantic reviewer in shadow mode over frozen evidence. It should test whether the cited observations establish execution binding, rather than merely require fields or authentic references. Retain the byte-flow and skipped-branch controls and measure completion, latency and accounting separately. No such reviewer or extra paid round is implemented here.

These are small, correlated synthetic cases with simple historical candidates. The findings assume faithful recorded interpreter and utility semantics. They do not establish production reliability, large-history retrieval quality, retry behavior, partial-read thresholds or a speed/cost improvement. No live Sprite, UI/browser, server, push, merge or deployment change is included.

Raw evidence is preserved in `.artifacts/investigator-evidence-chain/`: `manifest.json`, `corpus.json`, six `*-report.json` files, transport/trace JSONL, `round.log`, `batch-status.json`, `analysis.json`, `analysis-summary.json` and `cleanup-inventory.log`. Earlier experiment evidence remains intact.
