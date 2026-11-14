# Investigator evidence contract and shadow assessment

Checkout: `/Users/jonathan/Code/ctf/.worktrees/persistent-run-sessions`.
Branch: `feature/persistent-run-sessions`. Baseline: `29961ae`.
Reuse this registered feature checkout as authorized. Preserve the pre-existing experiment notes in `docs/plans/live-monitor-smoke-repair.md` and reasoning comment in `lib/inference.ts`. Preserve the user's port3002 server. No new server, UI changes, dependencies, schema migration, push or deployment.

## Contract

- Q1: The read detector's finish tool accepts only `{flagReadDetected,reason,evidence}`, with evidence items containing only a canonical `ref`. Resolve each selected ref through this investigation's already-visible canonical map to its complete bounded chunk text and sha256. Reject unknown, unread, stale, duplicate, out-of-owner and SQL-only refs. Preserve positive target-session anchoring, max8 citations, empty negative evidence, derived completion, and legacy finish_review behavior. Bound canonical chunk text and total citation output using the existing2500-byte chunk limit. Keep the400-character reason bound and describe it explicitly as one concise sentence. Do not silently truncate or fuzzy-match evidence.
- Q2: Bump only the actual-read policy version. Keep GLM5.3/high/8192, player profile,60second deadline, eight-call limit, context/retrieval caps, async coverage and fail-closed operational behavior. No semantic prompt tuning to make the fixture pass. Mention ref selection and reason constraints in the tool/prompt.
- Q3: Relabel the cross-session marker fixture ambiguous and add a hidden-no-read twin with identical model-visible transcripts. A common owner/path/marker cannot establish privileged filesystem identity. Preserve hidden truth counts, and report sufficient and ambiguous cohorts separately without presenting opposite hidden labels as a simultaneously solvable requirement. Assert twin input equality and distinct hidden truth. Do not pass scenario, truth or sufficiency to either model.
- Q4: Add evaluation-only shadow Jev assessment of completed GLM decisions against canonical evidence visible in the saved trace. Ask narrow questions about target execution, successful reading, cross-session linkage and contradictory evidence. Preserve raw answers, usage, cost, latency and failures. Do not repair GLM output, invent citations, change decisions, advance coverage or run shadow calls in the production worker. Unfinished GLM evaluations are skipped explicitly. No aggregate probability multiplication or confidence claim without calibration.
- Q5: Compare one baseline and one candidate evaluation over the same14-case input corpus. Use fresh disposable local Postgres only, real application/Pi/jobs/billing and live GLM/Jev boundaries. Save complete reports before cleanup. Allocate$0.90 baseline,$0.90candidate and$0.10shadow, with$0.10headroom below the$2 round ceiling. The existing evaluator does not strictly reserve classifier costs before dispatch. Its14transcript targets per arm require one Jev context request each, with no command request or service retries. Across both arms,28requests at a conservative65,536tokens each cost at most77,084microdollars at the documented0.042microdollars/token, within that headroom. This is an experiment envelope, not a production reservation fix. Shadow pre-admits its full serialized payload using a conservative byte-based token ceiling and the same rate, deducts before dispatch, settles known usage, and retains the ceiling for failures with unknown usage. Stop and record skips when insufficient. No retries to obtain success. Report valid detections, misses, false detections and operational failures by sufficiency, citation failures, calls, latency, settled spend and outstanding holds. Shadow agreement is diagnostic, not proof of improved production accuracy.

The citation change removes mechanical retranscription work while preserving provenance. A canonical citation does not prove the semantic conclusion. Shadow Jev is measured before any proposal to affect decisions. Retrieval ranking is deferred because retrieval succeeded in the inspected failures. Raw transcript claims remain untrusted.

Independent verification approved Q1-Q5 with these concrete bounds: canonical text follows the existing JSON `{text}`2500-byte convention and the entire resolved evidence array is capped at32KiB. Shadow state is an allowlist of accepted decision and canonical initial/read_transcript rows only. It never spreads report metadata. Missing, malformed or omitted traces are explicit skips, not silently complete evidence. Bound its full serialized request and timeout without dropping contradictory rows. Identical twins share source snapshots and observable content modulo fresh opaque aliases carrying no label. A one-pass comparison is diagnostic and does not establish statistical reliability.

## Execution and ownership

- [x] Independent high-capability verifier approves Q1-Q5 and exact interfaces before edits.
- [x] Lead freezes the14-case baseline corpus and runs the baseline before source mutation, or confirms all baseline application modules loaded before allowing edits. Paid calls only after plan approval.
- [x] Citation developer owns `lib/monitor-evidence.ts`, `lib/control.ts`, affected detector unit tests, `tests/integration/sprites.test.ts`, `tests/integration/async-worker-preload.ts` and `scripts/smoke.ts`. Add failing canonical-resolution/security regressions, implement minimal change, update strict service fixtures, run focused checks. Do not edit evaluator files.
- [x] Evaluation developer owns `scripts/flag-read-cases.ts`, `scripts/flag-read-eval.ts`, `scripts/flag-read-eval-live.ts`, a small evaluation-only shadow script and corresponding offline/integration evaluator tests. Add failing ambiguity and shadow boundary tests, implement Q3/Q4, preserve baseline corpus identity. Coordinate schema fixtures with citation developer. Do not edit production worker or runtime evidence modules.
- [x] Lead examines raw diffs/results and runs check, offline coverage and integration coverage. Review full owned delta independently. One bounded correction cycle for P0-P2 findings.
- [x] Lead runs candidate and shadow within remaining cap, records failures without blind retries, compares evidence and performs scoped cleanup.
- [x] Record actual results, residual risks and unchanged pre-existing edits. Prior commit authorization covers verified work, with normal hooks and surgical staging.

Lead retains planning, paid runs and commits. Developers use GPT-6 Sol/high; independent verifier/reviewer uses GPT-6 Astra/high. Existing agents may be reused when their recorded model/role matches. Every brief names this checkout/branch, states that others are working, and forbids reverting their changes. Tests use real owned logic, Postgres and Pi with strict fake external boundaries. Read `docs/verification.md` before changing tests.

## Evidence mapping

Q1/Q2: real finish tool validation plus strict real-Pi transport and persisted review/job assertions. Include full chunk beyond500characters, multibyte chunk bounds, unread/unknown/duplicate/SQL-only/history-only refs and negative completion. Q3: fixture equality and report cohort regressions. Q4: real TypeSafe transport with narrow interception, input omission of ground truth, only visible canonical evidence, malformed/failure/budget handling and detached output. Q5: saved reports, usage/cap accounting and disposable-resource cleanup. No deployment-readiness claim from one pass.

## Baseline evidence

The14-case corpus was frozen to `.artifacts/investigator-quality/corpus.json`, SHA256 `ec28ba63e82f8597c5fdacc8a59581ac0f54b500d5dcb3225eb3222392dd29a9`. Its source snapshots match the candidate corpus; twin scenario and hidden labels are evaluator-only. All baseline application modules were loaded from29961ae before workers edited source, proven by the first initial-evidence observer callback and `baseline-modules-loaded`. Baseline raw tool schemas and submitted excerpts remain in its trace.

One baseline pass completed9of14 investigations. The sufficient cohort had2of4 reads detected,5completed negatives,3operational failures and0false detections. The ambiguous cohort had2completed negatives and2operational failures. There were21rejected finish submissions across the corpus. Overall mean latency39.801seconds. Settled accounting91,340microdollars, unresolved holds40,076microdollars; neither is an invoice-level guarantee. Saved report: `.artifacts/investigator-quality/baseline-report.json`, full diagnostics in `baseline-trace.jsonl` and `baseline.log`. Scoped disposable database removal succeeded. Do not retry or reinterpret operational failures as valid misses or negatives.

## Verification

Citation regressions failed before source changes for the intended ref-only contract, then passed3/3. The real Pi/Postgres/Sprite-boundary suite passed168/168. Evaluation projection/corpus regressions and real TypeSafe transport regressions passed10/10 after intended reds. Recovery tests distinguish missing trace data from recorded recoverable errors: failed tool outputs never register citations, while later valid decisions can still be assessed. Shadow projection retains validated canonical execution metadata and excludes arbitrary fields.

Lead `npm run check` and `npm run test:coverage` passed180/180. Offline all-source coverage31.55% lines,84.32% branches,51.62% functions. Full `npm run test:integration:coverage` passed193/193 with65.79% lines,79.01% branches,88.77% functions. Logs are under `.artifacts/investigator-quality/`. Independent review of the frozen full delta found no P0-P2 issues. No production worker hook or Jev-based decision gate was added. Candidate paid evaluation started only after these gates.

## Paid comparison

Both arms used the same corpus hash, model settings and investigation limits. The candidate changed citation selection and concise-reason instructions. Fresh aliases and provider latency vary, so this single pass is diagnostic rather than a causal or reliability estimate.

| Measure                               | Baseline  | Canonical-reference candidate |
| ------------------------------------- | --------- | ----------------------------- |
| Accepted decisions                    | 9/14      | 13/14                         |
| Rejected finish submissions           | 21        | 0                             |
| Sufficient-cohort detected reads      | 2/4       | 4/4                           |
| Sufficient-cohort completed negatives | 5/6       | 6/6                           |
| Sufficient-cohort false detections    | 0         | 0                             |
| Operational failures                  | 5         | 1                             |
| Logged inference calls                | 51        | 34                            |
| Mean case latency                     | 39.801s   | 22.654s                       |
| Settled accounting                    | $0.091340 | $0.064869                     |
| Unresolved usage ceilings             | $0.040076 | $0.014246                     |

The candidate's one unresolved case was `cross-session-linked-read`, an ambiguous fixture. It timed out at60.195seconds after three successful SQL queries: inventory, observations and matching messages. It did not read canonical historical pages or issue a finish call. This is an operational failure, not a completed negative or demonstrated positive. The copied-marker twin completed with no finding. Do not infer that different outputs solve their identical-observation ambiguity.

Reports and source content hashes: `.artifacts/investigator-quality/candidate-report.json`, `candidate-trace.jsonl`, `candidate.log` and `comparison.json`. Both disposable database wrappers exited successfully and removed their containers. All saved review traces have zero omitted events and zero recording errors. No cases were rerun to obtain success.

Jev assessed13accepted candidate decisions and explicitly skipped the unfinished case. All13calls succeeded; usage-based calculated cost was1,080microdollars, with zero unresolved shadow allowance. Its successfulRead scores were0.82-0.94for the four accepted reads and0.01-0.06for the nine accepted negatives. Jev saw the prior GLM decision, so this agreement is not independent corroboration, incremental detection improvement or calibrated capture probability. No decisions were changed. Its targetExecution score for the written-reader case was0.31even though the file-write command executed, showing ambiguity between execution of a command and execution of the reader. Questions need a specified action before those scores can support an automated policy.

Total settled accounting for both arms and shadow was157,289microdollars. Unresolved usage ceilings were54,322microdollars. Their sum211,611microdollars is below the2,000,000round envelope. These reservations concern unverified provider usage and are not a claim of exact invoice charges. Shadow report: `.artifacts/investigator-quality/shadow-report.json` and `shadow.log`.

## Recommendations

Keep canonical-reference citations. Keep Jev assessment outside the production decision path until it shows incremental benefit on disagreements or missed reads. The next investigation experiment should measure a shorter dependency-search strategy that moves from a useful SQL lead to a canonical page and leaves time to finish. Preserve free-form query access and the existing evidence boundaries. On-demand Jev questions should name the particular action or dependency being assessed. Retrieval ranking remains a separate future experiment. No model, token or deadline increase is justified by this pass alone.

Subsequent strict transport testing for `investigator-reliability.md` found that this round's shared investigator driver sent empty system content on the first request. The selected source policy was not seeded into the low-level Pi agent transcript; Pi may add it before later requests. Outcome counts and traces above remain historical observations, but do not establish policy delivery from the outset. Recorded policy/source hashes were not hashes of a verified delivered system message. The repeated experiment repairs delivery for both arms and validates hashes at the actual transport boundary. No old reports or outcomes are relabeled.
