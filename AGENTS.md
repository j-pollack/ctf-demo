<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Feature worktrees

All new features and feature changes require a dedicated branch and Git worktree at `<primary-checkout>/.worktrees/<feature-slug>` before any feature plan, test, or source edits. Resolve the primary checkout from `git worktree list --porcelain`, even when starting in a linked worktree; never create nested `.worktrees/`, sibling checkouts, or directory copies. Use the existing `npm run worktree -- add <absolute-path> <feature-branch>` helper. Reuse only a registered worktree matching the intended path, branch, and feature; refuse path/branch collisions or unsafe existing changes.

Record the absolute feature worktree path and branch in the plan and every agent brief. The lead, developer, plan verifier, and reviewer use that checkout/CWD for all edits, checks, reviews, and commits; keep the primary checkout unchanged. Do not merge, push, or deploy without user authorization. After an authorized merge, clean up the completed feature worktree: confirm it is clean (including untracked files), its branch is fully merged into the target, and no agent or development server is using it; switch to the primary checkout, run `git worktree remove <absolute-feature-path>`, then `npm run worktree -- init` to prune its port reservation. Never force removal or discard unmerged/dirty work; report blockers instead. Keep the branch unless deletion is also authorized. Worktrees isolate source, not databases, credentials, or services: the testing policy below still applies.

# Repository skills

`.agents/skills/` is the single source of truth for repository skills. `.claude/skills` is a relative symlink to `../.agents/skills`, not a second skill store.

- Create or update skills at `.agents/skills/<skill-name>/SKILL.md`, with `name` and `description` in YAML frontmatter.
- Keep supporting files inside the same skill directory and use relative paths to reference them.
- Install imported skills into `.agents/skills/` too; check for existing names before adding or replacing a skill.
- Preserve the `.claude/skills` symlink. Do not replace it with a directory, duplicate skills there, or introduce a sync script.

# Testing and mocking policy

All coding agents must follow [the verification strategy](docs/verification.md).

- Keep unit tests dependency-free: no database, network, SDK sessions or credentials. Test real owned logic, not mocks of that logic.
- Integration tests must use real application orchestration, Postgres SQL/transactions, Better Auth, Pi SDK, validation and route handlers. Never mock ownership/auth decisions, leases, billing admission/settlement, monitor parsing or transcript repair to make a test pass.
- Stub only external service boundaries (OpenRouter, Resend, Fastmail and Sprites). Use the existing transport interception where possible; add only a narrow injection seam when necessary. Do not build a fake database, parallel application or general shell emulator.
- Service fakes must validate requests, maintain the minimal state needed by the scenario and fail on unexpected calls. Never silently fall through to live services or return unconditional success. Exercise failures, timeouts, aborts and retries as well as happy paths.
- Assert observable outcomes: persisted balances/events, denied execution, actual command arguments, HTTP/cookie/stream behavior and cleanup. Mock call counts alone are not proof. Concurrency checks must assert successful admission as well as upper bounds.
- Pair each fake boundary with a small real-service deployment contract check. Fake Sprite tests prove orchestration, not Linux execution, VM isolation or network enforcement; those require real Sprite smoke tests.
- Use disposable test databases and synthetic credentials. Never use shared `.env.local` credentials, paid services or unscoped cleanup/reconciliation in unattended tests. Live smoke/e2e is opt-in and required before deployment promotion, not pre-commit.
- Measure coverage across all owned runtime source, including unimported files. Coverage complements named security/accounting regressions; do not inflate it with mocks, broad exclusions or assertions of implementation trivia. Report unrun checks honestly.
- Run `npm run check` for offline changes. Use `npm run test:coverage` when changing test coverage; add a targeted regression for changed behavior. Keep the existing Node test runner unless a concrete limitation requires another tool.
