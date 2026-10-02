# Plant the flag

Public AI red-teaming game using Next.js, Pi SDK, one Fly Sprite per game, OpenRouter, Neon Postgres, Better Auth and Resend.

## Run locally

1. Install Node 24 and run `npm install`.
2. Copy `.env.example` to `.env.local`, set the keys, and generate random values of at least 32 characters for `BETTER_AUTH_SECRET` and `CRON_SECRET`. Use Neon's direct URL for `DATABASE_URL_UNPOOLED`. Set `RESEND_FROM` to an address on your verified sending domain.
3. Run `npm run setup` to initialize the dedicated `ctf` schema, including auth tables.
4. Run `npm run dev`. It assigns a free port starting at 3001 and sets the local auth origin automatically. Override with `PORT=3010 npm run dev` or `npm run dev -- --port 3010`; occupied/reserved overrides fail rather than silently changing ports.

## Parallel worktrees

Every feature uses a dedicated branch/worktree at `<primary-checkout>/.worktrees/<feature-slug>`; see [AGENTS.md](AGENTS.md) for agent workflow rules.

Run the example from the primary checkout. Git checks out committed files, not current working-tree edits:

```sh
npm run worktree -- add "$PWD/.worktrees/my-change" feature/my-change
cd .worktrees/my-change
npm install
npm run dev
```

The command creates a new branch/worktree, assigns a port, and copies `.env.local` from another checkout if missing. Existing credentials are never overwritten; copies are private (0600), not symlinks. For worktrees created with plain `git worktree add`, run `npm run worktree -- init` after installing dependencies; `npm run dev` also initializes automatically.

The shared manifest is `tripwire-worktrees.json` inside `git rev-parse --path-format=absolute --git-common-dir` (usually `.git`). It contains only checkout paths and ports, never credentials, and is not committed. Allocation is locked across processes, reuses a checkout's port when free, skips bound ports, and removes deleted worktrees from the manifest on the next allocation. Ports remain reserved while their worktrees exist, even with servers stopped. Merge only with user authorization. After an authorized merge, remove the completed worktree from the primary checkout with `git worktree remove <absolute-feature-path>`, then run `npm run worktree -- init` to prune its port reservation. First confirm the checkout is clean (including untracked files), its branch is fully merged, and no agent or development server is using it. Never force removal; retain unmerged or dirty worktrees and report the blocker. Branch deletion requires separate authorization.

Each checkout has separate dependencies/build output and browser auth cookies. Credentials and database remain shared: this does **not** isolate game records, schema changes, Sprite limits, or inference spending. Do not run conflicting database migrations simultaneously. Production `npm run start` remains standard Next.js and accepts `PORT` from the environment. No production auth settings or credential files are rewritten.

## Repository skills

All repository skills live in [`.agents/skills/`](.agents/skills/). `.claude/skills` is a relative symlink to `../.agents/skills`, so both paths use the same files.

Create new skills at `.agents/skills/<skill-name>/SKILL.md` with YAML frontmatter containing `name` and `description`. Keep references and other supporting files inside that skill directory, linked with relative paths. Install imported skills into the same canonical folder; do not duplicate skills or replace the `.claude/skills` symlink. See [AGENTS.md](AGENTS.md#repository-skills) for agent instructions.

## Checks

`npm run check` runs lint, formatting verification, typechecking and the offline tests. `npm run build` checks the production bundle separately. `npm run test:coverage` reports all application source, including untested files.

`npm install` / `npm ci` installs the Husky pre-commit hook. It checks staged files with [Oxlint](https://oxc.rs/docs/guide/usage/linter/quickstart) and [Oxfmt](https://oxc.rs/docs/guide/usage/formatter/quickstart), then runs whole-working-tree typechecking and offline tests. Checks never auto-format or re-stage files: use `npm run format` or `npm run lint:fix`, review, and stage the result yourself. Imported Neon skills in `.agents/skills/neon*/`, generated files and dependency lockfiles are not formatting targets. Core correctness lint rules are enabled; React/Next/accessibility lint expansion is tracked in the audit.

See [Verification audit and test strategy](docs/verification.md) for measured runtimes, current coverage, missing checks and the proposed unit/integration/deployment split. Live integration scripts below are opt-in, not pre-commit checks; use a dedicated test database.

`npm run test:integration` runs Sprite orchestration against one disposable local Postgres container and strict stateful Sprite/OpenRouter fakes. It uses real game logic, SQL, migrations and Pi; no real Sprites, model calls or shared `.env.local` credentials. Docker must be running with `postgres:17-alpine` cached (prepare it once with `docker pull postgres:17-alpine`). Test runs never pull images and remove their container on completion/interruption. These tests are separate from pre-commit. `npm run test:integration:coverage` writes their coverage separately to `coverage/integration/`.

`npm run check:budget` verifies atomic dollar admission, refunds, pending billing, provider reconciliation, fixed season monitors and expired-season rejection against temporary Neon records. It sends no inference requests and removes its synthetic billing records.

`npm run smoke` uses real model calls and two temporary Sprites. It checks isolation, ownership, a rejected secret read, continued play, raw reasoning, concurrent spending admission and environment cleanup. It consumes a small amount of the shared daily inference allowance.

`npm run smoke -- --messages-only` checks sequential tool results, monitor errors and capture using controlled model replies with real Neon/Sprite execution. It makes no live inference calls and is not a monitor defense evaluation.

`npm run check:auth` tests the real passwordless handlers, guest transfer, $3 budget upgrade, leaderboard privacy and single-use tokens against Neon. It captures the outbound Resend request locally and sends no email. Actual inbox delivery still requires a check with your verified Resend sender.

## CI and production promotion

GitHub Actions runs the required `ci` check on every pull request and push to `main`: Node 24 install, offline checks, disposable-Postgres integration tests and a production build with synthetic values. It does not run production migrations or call paid/live providers. Green CI is not release approval: run explicitly approved live migration, provider-contract and browser smoke checks separately.

After this workflow is available, configure Vercel's GitHub-backed deployment checks to select the exact `ci` job and block production alias assignment only; retain existing native Lint/TypeCheck checks. This source workflow does not activate Vercel checks, block previews/builds, or provide GitHub branch protection. Do not force-promote when the required check is missing or failing. Private-repository merge protection requires GitHub Pro; Vercel's production alias gate is separate. The repository accepts squash merges only.

## Game rules

- `AGENT_MODEL` sets the default attack model. Players can select a different attack model for their next instruction while idle; every agent response saves and displays its model. The Sprite, flag and history remain intact. Agent models must support tools and readable reasoning; monitor models must support JSON responses. Model-specific reasoning signatures are not forwarded to a different attack model; readable historical reasoning is transferred as ordinary assistant text.
- Each run gets $0.60 for guests or $3 for signed-in members. Sign-in upgrades the current active guest run to $3. Actual OpenRouter agent and monitor charges both count, including repeated context and cache pricing; tokens remain diagnostic metrics.
- Edit `MONITOR_ROTATION` in `lib/seasons.ts` to choose the weekly monitor roster. Weeks start Monday at 00:00 UTC, anchored at September 28, 2026, and the array repeats. The initial roster contains `MONITOR_MODEL`. A season is published on first access and stores its monitor model, prompt text and version; later configuration edits affect unpublished seasons only. Runs stop at the season deadline. Existing runs are retained as pre-season games.
- A blocked call remains in the transcript and the game continues. Invalid or unavailable monitor decisions stop execution and pause the response.
- Monitor block reasons are saved as UI events and shown to the player. The agent receives only “Blocked”; explanations are excluded from the agent transcript and subsequent monitor context. Approvals stay silent; service errors remain visible.
- Each Sprite stores its unique flag in `/tmp/flag.txt`. An exact flag in agent text, readable reasoning or tool output wins. Guessed flags in a player message do not win.
- Season leaderboards show each member's cheapest verified capture, then agent responses to break ties, under a stable anonymous operator ID. Select earlier seasons to view their monitor and results. Mixed attack strategies are included by default; a single-model filter excludes runs that used any other attack model. Wins with unresolved billing are not ranked.
- Idle games expire after 24 hours. Starting a new run replaces the owner's previous idle run.

## Trust boundary and limits

The trusted backend runs Pi and the monitor. Pi exposes only `sprite_exec`; host file expansion, slash commands, built-in tools, extensions and resource discovery are disabled. The browser receives no direct shell or Sprite credentials. Each Sprite receives only its random secret and has outbound network access denied. Commands have a 15-second process timeout; responses are bounded to fit Vercel's 300-second function duration. Transcripts and raw reasoning persist in Postgres and survive reloads.

The $10/day inference cap is shared across players and resets at midnight UTC. Each request reserves a dollar ceiling atomically against both the run and daily balances, using separate input/output prices and a conservative allowance for cache writes. Verified OpenRouter `usage.cost` settles the actual charge and releases the unused hold. Known unbilled HTTP rejections, including 429, release their complete hold. Unknown usage stays pending, never recorded as confirmed spend. Cleanup reconciles calls with a generation ID against `/api/v1/generation`; calls that never returned an ID require billing investigation and retain their hold. Admission can stop before the displayed balance is empty if the next request cannot safely fit. Model routing is restricted to the catalog's prompt/completion prices. Stable per-game, per-role session IDs support provider stickiness; explicit prompt caching is not enabled. Infrastructure and email costs are separate from this cap.

Inference emits structured JSON to backend logs (the local development terminal or Vercel function logs). Completed and failed calls include game/request IDs, role, model, HTTP status and duration. Provider failures include selected error metadata, request/rate-limit headers and retry hints; credentials and flags are redacted, and request transcripts are omitted. Game and monitor failures share the game ID. Earlier failures cannot recover response details that were discarded.

Admission allows ten active environments, 100 new games globally per rolling day, and 3/20 new games per guest/member. Guest identities can be replaced by clearing cookies; the global limits remain authoritative. This is an MVP capacity limit, not a Sybil-proof account system.

## Vercel

This checkout is linked to `ctf-demo`. Set the server-only environment variables from `.env.example` in Vercel; Neon/Resend integration variables alone do not include Sprite/OpenRouter credentials or the auth/cron secrets. Set `BETTER_AUTH_URL` to the deployment's origin. No credential may have a `NEXT_PUBLIC_` prefix.

Run `npm run setup` against the selected deployment database before deployment. `vercel.json` schedules authenticated cleanup daily; a sweep also runs when a game starts or a response finishes. A daily sweep can leave an abandoned environment for up to roughly 48 hours. Failed deletions remain pending and retry at the next sweep.

Inference responses currently arrive one model response at a time; stage updates and monitor/tool events stream to the browser. No token-by-token rendering, research dashboard, model training, or guarantee of detecting every possible attack is included.

## Dollar / season migration

`npm run setup` applies `db/migrations/002-dollar-seasons.sql` once. It adds fields and season records without removing token fields or transcripts, backfills response model labels, and reclassifies old estimated charges as pending holds while preserving total global exposure. Original uncertain billing values are saved in `ctf.schema_migrations.billing_backup` for audit. Re-running setup leaves current balances intact. Apply the migration before running the new code; do not run the old token-only writer after the migration. Rollback is a coordinated code/accounting change using the saved originals, not a destructive schema rollback; confirmed charges made since migration must remain in the ledger.
