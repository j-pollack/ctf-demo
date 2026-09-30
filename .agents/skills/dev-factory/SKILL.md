---
name: dev-factory
description: Deliver software features and changes through a high-capability planner/lead, independent high-capability verification and review, and a scoped medium-capability developer. Use for feature implementation and feature behavior changes; exclude explanation-only, planning-only, and review-only requests unless explicitly invoked.
---

# Dev Factory

Use existing delegation, repository, and verification mechanisms. This is an orchestration recipe, not a new framework. Runtime permissions, repository instructions, testing policy, and user scope retain precedence. Invocation does not authorize live services, paid calls, shared-data mutations, deployment, or pushing.

## Four principles

1. **Think Before Coding.** State assumptions, surface competing interpretations and tradeoffs, push back on unnecessary complexity, and stop to ask about material confusion.
2. **Simplicity First.** Build the minimum adequate solution. Prefer existing code, standard libraries, and native features. No speculative features, single-use abstractions, unrequested flexibility, or impossible-case handling. Preserve necessary validation, security, error handling, and accessibility.
3. **Surgical Changes.** Change only what was requested, following existing style. No adjacent cleanup or removal of pre-existing dead code; remove only orphans introduced by this work. Preserve others' edits.
4. **Goal-Driven Execution.** Define observable success criteria and checks before implementation. Use TDD/regressions for behavior, before/after checks for refactors, and a brief step → verify plan. Completion is evidence, not an agent's assertion.

## Roles and selection

Inspect models and delegation controls actually advertised by the runtime. Select and disclose concrete model and reasoning-effort settings for each role; do not invent model names or unsupported controls. Capability tier and reasoning effort are separate: high reasoning on a medium model does not satisfy a high-capability role.

- **Persistent planner/lead:** a high-capability model with high reasoning effort. The same lead owns planning, steering, verification, commits, and completion throughout.
- **Plan verifier:** an independent high-capability agent with high reasoning effort, read-only.
- **Developer:** a medium-capability agent with an appropriate explicit reasoning effort, tightly scoped by the lead. It implements and simplifies but cannot redefine criteria, broaden scope, self-certify completion, or commit.
- **Code reviewer:** an independent high-capability agent with high reasoning effort, read-only and not the developer or lead. It may also be the plan verifier.

If the current agent is not high-capability, hand leadership to an explicitly selected high-capability agent, transferring the request, constraints, baseline, and available evidence; the original agent becomes a relay, not a pretend upgrade. If selection or delegation is unavailable, disclose the limitation and request an explicit user-approved fallback or report blocked. Never silently downgrade or claim a role/model setting that was not actually selected.

## 1. Understand and contract

Read applicable repository instructions and testing policy, inspect relevant code and every caller of the affected shared logic, and record initial Git HEAD, working-tree status, and staged diff. Record pre-existing changes and owned paths so later review and commits can distinguish this feature from concurrent work.

Before feature plan, test, or source edits, require a dedicated feature branch and Git worktree at `<primary-checkout>/.worktrees/<feature-slug>`. Resolve the primary checkout from `git worktree list --porcelain`, not the current CWD when inside a linked worktree. Never use sibling directories, directory copies, or nested `.worktrees/`. Inspect registrations, branch ownership, destination, and existing changes; reuse only the correct registered path/branch for this feature when safe, and refuse collisions or uncertain ownership rather than overwriting or switching others' work.

Prefer the repository's existing worktree helper (here, `npm run worktree -- add <absolute-path> <feature-branch>`); use `git worktree add -b <feature-branch> <absolute-path>` only if no helper exists. Record the absolute feature checkout and branch in the contract and every brief. Lead, developer, verifier, and reviewer use this checkout/CWD for all edits, checks, reviews, and commits; keep the primary unchanged. Worktrees isolate source, not databases, credentials, or services; existing testing and permission policy still applies. No automatic merge, push, or deployment. After a user-authorized merge, clean up the completed feature worktree as described below; do not remove unmerged or dirty worktrees.

The lead saves a durable Markdown behavior contract in the repository's established plan location, otherwise `docs/plans/<feature-slug>.md`. Preserve this artifact through completion; no rendered page or hosting is needed. Include:

- Scope, non-goals, assumptions, competing interpretations/tradeoffs, and material unresolved questions.
- Observable given/when/then criteria with stable identifiers and relevant failure cases.
- A criterion → check → actual evidence/status mapping, including commands and required prerequisites.
- Surgical implementation steps, exact ownership, and verification commands: step → verify.

Ask on material ambiguity rather than implementing a guessed contract. Prefer the smallest adequate solution; do not weaken criteria to make tests pass.

## 2. Independently verify the plan

Give the plan verifier the request, contract, repository constraints, and relevant source. Require a read-only assessment of clarity, feasibility, simplicity, and whether the mapped checks prove each criterion, including failures. Resolve blocking findings and material questions before development. A changed behavior contract must be independently reverified before further implementation.

## 3. Delegate, develop, and prove

Give the developer an exact brief: approved contract, owned files/responsibilities, scope exclusions, applicable instructions, checks, and escalation rules. Say explicitly that it is not alone in the codebase and must not revert others' changes. Unexpected scope, prerequisite failures, or criterion changes return to the lead rather than being improvised.

For changed behavior, add the smallest meaningful regression first, run it, and record failure for the intended reason before implementation; then implement and show it passing. A setup/import failure is not TDD evidence. For refactors, establish passing behavioral checks before edits and repeat afterward. Documentation-only work uses appropriate structural validation and, when warranted, realistic behavioral application—not pointless tests of wording.

Use the repository's actual testing policy: test owned logic and real required components, stub only permitted external boundaries, and assert observable outcomes. Never substitute mocks for the decision or invariant under test. Run required repository gates and changed-surface checks; browser-visible changes require the mandated browser inspection/QA. The lead examines raw results and runs verification itself rather than accepting a worker's summary as proof.

Repeat scoped test → develop → verify until every criterion has evidence. The developer returns the actual diff, commands/results, failures, and blockers. Record actual evidence and remaining limitations in the contract. Unrun checks stay unrun; missing required proof blocks completion. Stop loops on repeated failures without new evidence, unavailable prerequisites, or decisions requiring user input.

## 4. Checkpoint and simplify

After lead verification, checkpoint verified owned changes using the commit safeguards below. Then have the developer simplify only where there is a concrete improvement within scope. Preserve every criterion, rerun affected checks, and have the lead verify results. Stop when no useful simplification remains; no deletion quotas, line-count targets, or endless cleanup. Commit this stage only if it changed something.

## 5. Review the full feature and bound correction

Give the code reviewer the original request, approved contract, initial baseline, ownership record, full feature delta through every checkpoint plus pending changes, and raw verification evidence. Review must not be limited to the latest commit or worker summary. Concurrent/unrelated changes remain outside edit scope; disclose attribution uncertainty. Require findings with priority, location, impact, and missing proof, and an explicit assessment of criteria and safety.

If there are P0–P2 findings, allow **one automatic corrective cycle**: lead briefs a scoped regression/TDD → fix → verify → checkpoint, then useful simplification → verify if needed, followed by independent re-review of the full feature. The reviewer never edits. Reopen planning only for a defective requirement or approach; do not redefine success to dismiss a finding.

If any P0–P2 remains **or newly appears** on re-review, stop edits, diagnose with the reviewer, and report evidence and the required decision to the user. No automatic second repair cycle, even under a new label or revised plan. Report lower-priority findings without expanding scope.

## Commit safeguards and finish

Only the lead commits, when authorized and verification permits. Before each commit inspect Git status, owned hunks, and staged diff. Stage only intended owned changes, never sweep up pre-existing staged work. If the index contains unrelated changes or attribution is unsafe, stop for a safe user-approved resolution; do not reset, stash, or rewrite others' work. Do not bypass hooks, rewrite history, push, or deploy without authorization. Report commit/hook failures; do not treat them as success or repair unrelated code to force a commit.

Before the final commit, record final criterion/evidence status and already completed checkpoint IDs in the durable contract. Commit only if verified intended changes (including this bookkeeping) remain; no empty commits. Report the final commit ID afterward, never embed the contract’s own commit hash or create an endless bookkeeping commit loop.

Done requires evidence for every criterion, all required checks passed, no outstanding P0–P2 findings, and intended changes committed. If permissions or an explicit no-commit instruction prevent that state, report the precise limitation rather than claiming the full factory completed. Finish with commit IDs, verification actually run, and remaining limitations.

## Clean up completed worktrees

After a user-authorized merge, remove the completed feature worktree so it does not remain dangling. If the work is not merged, retain it and report its path and branch; a verified commit alone is not permission to discard a checkout.

- Confirm the exact feature path/branch from `git worktree list --porcelain`, a clean index/worktree (including untracked files), and that `git merge-base --is-ancestor <feature-branch> <target-branch>` succeeds. If any check fails, stop and report the blocker; never use `--force` or discard changes.
- Stop any development server and ensure no agent is still using that checkout. Change CWD to the primary checkout before running `git worktree remove <absolute-feature-path>`.
- Refresh the repository's worktree registry with `npm run worktree -- init` from the primary checkout so the removed checkout's port reservation is pruned. Confirm the path is gone from both Git's worktree list and the registry.
- Keep the feature branch unless the user also authorized branch deletion. Report merge and cleanup results; a cleanup failure remains an explicit unfinished step, not a successful cleanup.
