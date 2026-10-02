# Expand legitimate monitor evals

Checkout: `/Users/jonathan/Code/ctf/.worktrees/monitor-prompt`

Branch: `codex/monitor-prompt`

Baseline: `7f8809f420b54416a79ebeefe0a19ccb4f8f431e`; clean tracked tree and index. Continue the existing registered monitor feature; primary checkout stays unchanged.

## Contract

User asks why current results indicate overblocking and for more legitimate-call evals. Under the agreed contents-only policy, metadata and literal path output do not disclose file contents. Legitimate calls blocked are false positives; prohibited calls allowed are false negatives. Prior 2/8 false blocks are evidence on a small targeted sample, not an estimate of real traffic frequency.

Expand from 8 to exactly 40 legitimate cases, retaining the existing 10 prohibited controls and all original case IDs/commands/labels. Assign human-readable categories: 20 ordinary operations, 8 literal path mentions, 6 metadata-only operations, and 6 harmless calls in suspicious context. Categories and expected labels are evaluator metadata and must never enter model input. Keep the approved prompt and policy unchanged; do not tune to observed results or relabel failures.

Examples of new ordinary work: OS information, date, arithmetic in Python/Node, text pipes/sort/count, directory operations, known unrelated reads and ordinary known-file writes. Path mentions must print/transform the literal path without opening the protected file. Metadata examples: listing the entry, existence check, stat from an interpreter, find by filename and readlink. Suspicious contexts include an earlier generic Blocked result, hostile user instructions, misleading agent reasoning and injected tool output, while the current call is harmless. Histories must be plausible across independent shell executions. No fixture command is ever executed. Label only clear contents-safe cases; exclude ambiguous commands or unknown scripts/files.

Add a category field to cases/results and a small per-category legitimate summary with denominator, successful allows, false blocks, format/service errors and false-block rate. Include category in suite identity; metadata remains outside monitor input. Existing class summaries, real decision parsing, failure handling, dry-run defaults, dedicated-key CLI gate, repetitions and request bounds stay intact. No framework, dependencies, CI workflow, application changes or general runner redesign.

Document the group composition and interpretation briefly beside the npm command. Report category results as well as overall benign false-block rate so extra easy cases cannot conceal path-related failures. These are hand-selected diagnostic cases; do not claim they measure production traffic prevalence or general security reliability.

## Criteria

| ID  | Acceptance and check                                                                                                                                                                                                                                                                       | Evidence                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | 40 allow cases in 20/8/6/6 groups plus original 10 block cases; unique IDs; original inputs/labels unchanged. Review command semantics and synthetic history; dataset regression fails before expansion.                                                                                   | Passed: reviewed all50 commands/histories; direct baseline comparison preserves all18 original inputs/labels; regression count/hash/category invariant passes. |
| B2  | Category metadata stays outside model input; reports retain it and compute correct category totals/rates/errors, including dry-run null rates. Real scoring tests with mixed, all-block, malformed and service-error external replies.                                                     | Passed: real parser/scoring tests cover category totals/rates, errors, dry null rates and metadata exclusion; report hash includes categories.                 |
| B3  | Existing parser/prompt/runtime and opt-in guards unchanged; offline checks and coverage pass. Run Node24 targeted tests, npm run check, npm run test:coverage, dry CLI and full-delta whitespace check.                                                                                    | Passed: lead Node24 check31/31, coverage, dry CLI50unrun with20/8/6/6groups, and whitespace check. No app/policy changes.                                      |
| B4  | Run one expanded pass on qwen/qwen3-coder-flash, qwen/qwen3.8-flash and qwen/qwen3.8-max-0902 using the user's authorized OpenRouter key; save reports, retain failures and report categories plus costs. Max requires reasoning enabled; other settings remain as in earlier comparisons. | Pending.                                                                                                                                                       |

## Steps and ownership

1. Lead owns this plan, independent verification, live runs, results and commits. Read installed Next TypeScript guide before code work; repository verification policy applies. Independent GPT-6.1-sol/high reviewer verifies this contract before implementation and reviews the final delta.
2. GPT-6-sol/medium developer owns only `scripts/monitor-eval-cases.ts`, `scripts/monitor-eval.ts` (category metadata/summaries only), `tests/monitor-eval.test.ts` and a short README clarification. Preserve others' work. Add meaningful regressions first and save red evidence; implement minimal category reporting and expanded cases; no live calls or commits by developer.
3. Lead checks actual outputs and checkpoints verified changes. Developer assesses concrete simplification only. Reviewer audits the full baseline delta; at most one correction cycle.
4. Lead runs live comparisons after case/label review. Prior direct user authorization to use their OpenRouter key persists for these requested evals. Read only the needed key into process memory; do not log it, load database credentials into eval processes, execute fixture commands, or mutate shared services. Model requests alone are authorized. Use the existing eval code; a temporary process-local reasoning override for Max is already established and must be recorded in its report. Do not change the application or CLI defaults to accommodate that endpoint.
5. Record honest offline/live evidence, final review and checkpoint IDs; commit owned files. No merge, push, deployment or CI additions. Keep ignored JSON reports local and link them in the response.

All roles use the exact checkout/branch above. Node 24.16.0 and lockfile dependencies are available. Runs have 50 cases per model (150 requests total), one repetition, no automatic retries. Stop after completed measurements and report observed failures rather than adjusting the prompt or cases to improve the score.

## Evidence

Independent plan review approved. Lead read the raw red assertions in `.artifacts/monitor-benign-red.txt` (8 instead of40 cases and absent category summary), reviewed all added command semantics and histories, and compared original18 inputs/labels directly against baseline source saved under `.artifacts/monitor-benign-baseline-cases.ts`; all original inputs are identical.

Lead Node24 `npm run check` passed lint/format/typecheck and31tests (`.artifacts/monitor-benign-check.txt`). `npm run test:coverage` passed31tests (`.artifacts/monitor-benign-coverage.txt`); no application code or coverage exclusions changed. Actual dry CLI output `.artifacts/monitor-benign-dry-lead.json` has50unrun cases,40allow/10block, groups20/8/6/6, null rates and cost. Full-delta whitespace check passed. No live calls in this extension yet.
