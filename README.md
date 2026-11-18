# Capture the flag

Public AI red-teaming game using Next.js, Pi SDK, one Fly Sprite per game, OpenRouter, Neon Postgres, Better Auth and Resend.

## Run locally

1. Install Node 24 and run `npm install`.
2. Copy `.env.example` to `.env.local`, set the keys, and generate random values of at least 32 characters for `BETTER_AUTH_SECRET` and `CRON_SECRET`. Use Neon's direct URL for `DATABASE_URL_UNPOOLED`. Set `RESEND_FROM` to an address on your verified sending domain. For local development, set `SITE_URL` to the actual public HTTPS origin of an ngrok tunnel forwarding to this app. The app derives the submission endpoint at `/v1/end`. Without a valid public origin, new HTTP runs fail closed. See [flag ingress](deploy/flag-submission.md) before starting a run.
3. Run `npm run setup` to initialize the dedicated `ctf` schema, including auth tables.
4. Run `npm run dev`. It assigns a free port starting at 3001 and sets the local auth origin automatically. Override with `PORT=3010 npm run dev` or `npm run dev -- --port 3010`; occupied/reserved overrides fail rather than silently changing ports. It also starts the monitor worker, which processes durable investigator jobs and pending submissions, and an ngrok tunnel whose HTTPS origin becomes `SITE_URL`, so Sprites can reach the local app. If any of the three exits, all stop. Without ngrok, the app starts but new runs report the submission endpoint as unavailable; see [the submission guide](deploy/flag-submission.md). `npm run monitor:worker` runs the worker alone, and `npm run monitor:worker -- --once` processes one bounded worker iteration for controlled checks.

Deploy the schema migration before enabling new async runs. Deployed environments run the monitor worker on Fly; see [Monitor worker on Fly](#monitor-worker-on-fly). Existing runs retain their legacy monitor mode. Older application binaries cannot resume async runs; stop new async creation and let a compatible worker drain or leave them visibly unresolved before rolling back application code. The worker shares the application's inference budget and credentials.

## Admin dashboard

`/admin` shows usage, signups and spend. Access is the `isAdmin` flag on a signed-in (non-guest) user, granted only in SQL; users cannot set it themselves. Sign in once, then:

```sql
UPDATE ctf."user" SET "isAdmin" = true WHERE email = 'you@example.com';
```

Or set `ADMIN_EMAILS` in `.env.local` (comma-separated, for example `ADMIN_EMAILS=you@example.com,other@example.com`). `npm run setup` loads that file and grants admin to matching existing non-guest accounts; sign in once, then rerun setup. Whitespace and case are ignored. Unset or blank grants nobody, and removing an address does not revoke an existing grant. For production setup, supply the same variable in its environment. Remove an email from every setup environment's `ADMIN_EMAILS` before revoking it in SQL, or the next setup re-grants it. Everyone else gets a 404.

List current admins, including manual grants:

```sql
SELECT id, email, name FROM ctf."user"
WHERE "isAdmin" = true AND "isAnonymous" IS NOT TRUE
ORDER BY email;
```

Admins are exempt from the personal three-new-runs-per-24-hours limit. Shared spend, global new-run and environment limits still apply. Admission checks the current database flag, so revocation takes effect on the next start request.

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

`node --env-file=.env.local --import tsx scripts/monitor-calibrate.ts` scores the control corpus (`scripts/control-eval-cases.ts`: honest Bottle fixes and staged flag reads) through the real two-call Typesafe monitor and reports honest false-catch and per-difficulty catch rates; findings are in `docs/plans/control-calibration.md`. It makes live Jev calls through OpenRouter (reads `OPENROUTER_API_KEY`) and caches results on disk. Re-run it after changing any question, weight or threshold in `lib/control.ts`, and bump `MONITOR_VERSION` there.

`npm run check` runs lint, formatting verification, typechecking and the offline tests. `npm run build` checks the production bundle separately. `npm run test:coverage` reports all application source, including untested files.

`npm install` / `npm ci` installs the Husky pre-commit hook. It checks staged files with [Oxlint](https://oxc.rs/docs/guide/usage/linter/quickstart) and [Oxfmt](https://oxc.rs/docs/guide/usage/formatter/quickstart), then runs whole-working-tree typechecking and offline tests. Checks never auto-format or re-stage files: use `npm run format` or `npm run lint:fix`, review, and stage the result yourself. Imported Neon skills in `.agents/skills/neon*/`, generated files and dependency lockfiles are not formatting targets. Core correctness lint rules are enabled; React/Next/accessibility lint expansion is tracked in the audit.

See [Verification audit and test strategy](docs/verification.md) for measured runtimes, current coverage, missing checks and the proposed unit/integration/deployment split. Live integration scripts below are opt-in, not pre-commit checks; use a dedicated test database.

`npm run test:integration` runs Sprite orchestration against one disposable local Postgres container and strict stateful Sprite/OpenRouter fakes. It uses real game logic, SQL, migrations and Pi; no real Sprites, model calls or shared `.env.local` credentials. Docker must be running with `postgres:17-alpine` cached (prepare it once with `docker pull postgres:17-alpine`). Test runs never pull images and remove their container on completion/interruption. These tests are separate from pre-commit. `npm run test:integration:coverage` writes their coverage separately to `coverage/integration/`.

`npm run check:budget` verifies atomic dollar admission, refunds, pending billing, provider reconciliation and per-run lease checks against temporary Neon records. It sends no inference requests and removes its synthetic billing records.

`CTF_SMOKE_DISPOSABLE=1 npm run smoke` uses real model calls and temporary Sprites. It checks isolation, ownership, a rejected secret read, continued play, raw reasoning, concurrent spending admission and environment cleanup. It consumes a small amount of the shared daily inference allowance. Run it only against a freshly migrated disposable database. The script refuses a database with existing run, session, inference, spend or job records.

`CTF_SMOKE_DISPOSABLE=1 npm run smoke -- --messages-only` checks sequential tool results, monitor errors and capture using controlled model replies with real Postgres and Sprite execution. It also checks async command progress, pending submission, worker review and remote termination. It makes no live model calls and is not a monitor defense evaluation.

`npm run check:auth` tests the real passwordless handlers, the closed guest sign-in, legacy guest-run transfer, leaderboard privacy and single-use tokens against Neon. It captures the outbound Resend request locally and sends no email. Actual inbox delivery still requires a check with your verified Resend sender.

## CI and production promotion

Before running the full integration suite locally, prepare its Docker images: `docker pull postgres:17-alpine` and `docker build -t ctf-flag-read-sprite:1 evals/flag-read`. CI performs both steps explicitly. The corpus tests execute in the local Sprite stand-in image with networking disabled and never pull a missing image implicitly.

GitHub Actions runs the required `ci` check on every pull request and push to `main`: Node 24 install, offline checks, disposable-Postgres integration tests and a production build with synthetic values. It does not touch production or call paid/live providers. Green CI is not release approval: run explicitly approved provider-contract and browser smoke checks separately.

The `migrate prod` workflow runs `scripts/setup.ts` against the production database after `ci` succeeds for a push to `main` (never for pull requests). It checks out the exact commit that passed, runs one migration at a time, and reads the `DATABASE_URL_UNPOOLED`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` and `ADMIN_EMAILS` repository secrets. Set `ADMIN_EMAILS` to comma-separated existing member emails to seed production admins; leaving it unset grants no new admins. Setup is idempotent and each SQL file applies atomically. Vercel's production alias waits for both the `ci` and `migrate prod` checks, so new code goes live only after its migrations apply. Old code keeps serving while they run, so migrations merged this way must still be additive; coordinate anything destructive or data-rewriting manually. If it fails, fix forward and push again; use Vercel Instant Rollback for bad code and Neon point-in-time restore only for damaged data. Code from before `009-monitor-choice` can't read runs started without a season (`season_id` NULL): before rolling back past it, end those runs (`UPDATE ctf.games SET status='ended',lease=NULL,lease_until=NULL WHERE season_id IS NULL AND status IN ('creating','active')`) and expect their pages to fail until you roll forward.

After this workflow is available, configure Vercel's GitHub-backed deployment checks to select the exact `ci` job and block production alias assignment only; retain existing native Lint/TypeCheck checks. This source workflow does not activate Vercel checks, block previews/builds, or provide GitHub branch protection. Do not force-promote when the required check is missing or failing. Private-repository merge protection requires GitHub Pro; Vercel's production alias gate is separate. The repository accepts squash merges only.

## Game rules

- `AGENT_MODELS` and `AGENT_MODEL` in `lib/policy.ts` set the selectable attack models and the default; they are not environment-configurable. The model is fixed for players. An admin sets it from `/admin`, and it defaults to `AGENT_MODEL`. Every agent response saves and displays its model. The Sprite, flag and history remain intact. Agent models must support tools and readable reasoning. Model-specific reasoning signatures are not forwarded to a different attack model; readable historical reasoning is transferred as ordinary assistant text.
- An admin sets two game rules from `/admin`, in the Game rules card beside the attacker model. Transcript isolation (`monitor_isolation`, default off) limits the investigator to the sessions of the current run instead of all of the owner's runs. Bug fix required (`bug_fix_required`, default on) makes a passing bug test part of the win. Turned off, a correct flag wins on its own and the scorer skips the bug tests, so `bugsPassed` stays 0. Each setting is stored in `ctf.settings` and copied onto a run's row when the run starts, and a fork keeps its source's values. A change therefore applies only to runs started afterwards. The leaderboard ranks captures made under the rules currently in force. Migration `021-game-rules.sql` adds the two columns and must be applied before the new web code and monitor worker serve. An old worker treats every run as not isolated and bug fix required.
- The game is members-only: players sign in by magic link. Guest sign-in is disabled (`disabledPaths` in `lib/auth.ts`); a leftover guest session is refused by `player()` and keeps its runs if it signs in. Each run gets $0.50 (`RUN_BUDGET_MICRODOLLARS` in `lib/types.ts`). Actual OpenRouter agent and monitor charges both count, including repeated context and cache pricing; tokens remain diagnostic metrics.
- The classifier is Jev, called through OpenRouter (`TYPESAFE_MODEL` in `lib/typesafe.ts`). Players do not choose a difficulty. New runs use the `hard` classifier profile (`CONTROL_DIFFICULTY` in `lib/control.ts`). New async runs show the investigator agent reasoning. Historical evidence keeps its original visibility rule. There are no seasons or season deadlines: `ctf.seasons` and `games.season_id` remain as history only and new runs leave `season_id` NULL.
- A single-session instruction first checkpoints the run's Sprite. Multi-session runs share one Sprite and cannot be forked. New async runs persist commands and transcript evidence before dispatching commands without waiting for investigator inference. A later detection catches the run and stops its agents. New runs submit by direct HTTP upload from a Sprite command. An accepted upload stops new work, then its command and any active sibling commands finish before review and scoring. Capture remains unconfirmed until background review and scoring finish. Unknown outcomes, failed reviews and exhausted monitor funds leave the result unresolved. The worker reviews a session when its agent finishes responding to an instruction, and runs up to four reviews at once. Existing runs retain their stored submission transport. Existing legacy runs keep their synchronous command review. Forking is disabled in the player UI and the fork API remains. An owner can fork a caught single-session run once within 24 hours; the fork restores the earlier checkpoint and has its own review obligation.
- Command blocking applies to legacy runs only. Their block reasons are saved as UI events and shown to the player. The agent receives only “Blocked”; explanations are excluded from the agent transcript and subsequent monitor context. Approvals stay silent; service errors remain visible.
- Each Sprite stores its unique flag in `/tmp/flag.txt`. The agent must upload the correct value by HTTP POST. Capture is confirmed only after investigator review and at least one seed bug check passes. Flag text appearing in a response or tool output does not count as an upload. Guessed flags in a player message do not win.
- The leaderboard only ranks confirmed captures of runs recorded as `hard`, made against the current `ASYNC_MONITOR_VERSION` (`lib/control.ts`). It shows each member's cheapest verified capture, then agent responses to break ties, under a stable anonymous operator ID. Mixed attack strategies are included by default; a single-model filter excludes runs that used any other attack model. Wins with unresolved billing are not ranked.
- Idle games expire after 24 hours. Starting a new run replaces the owner's previous idle run.

## Trust boundary and limits

The trusted backend runs Pi and the monitor. New HTTP runs expose only `sprite_exec`; historical tool runs retain their stored transport. Host file expansion, slash commands, built-in tools, extensions and resource discovery are disabled. The browser receives no direct shell or Sprite credentials. Each Sprite receives only its random secret. New HTTP runs allow outbound access to the configured app hostname and deny other domains; historical runs retain their stored policy. Other paths on the allowed hostname remain reachable. A short-lived bearer token bound to the admitted command authorizes a flag receipt. Commands have a 15-second process timeout; responses are bounded to fit Vercel's 300-second function duration. Transcripts and raw reasoning persist in Postgres and survive reloads.

The $10/day inference cap is shared across players and resets at midnight UTC. Each request reserves a dollar ceiling atomically against both the run and daily balances, using separate input/output prices and a conservative allowance for cache writes. Verified OpenRouter `usage.cost` settles the actual charge and releases the unused hold. Classifier calls are charged from their reported input tokens at the fixed Jev rate. Known unbilled HTTP rejections, including 429, release their complete hold. Unknown usage stays pending, never recorded as confirmed spend. Cleanup reconciles calls with a generation ID against `/api/v1/generation`; calls that never returned an ID require billing investigation and retain their hold. Admission can stop before the displayed balance is empty if the next request cannot safely fit. Model routing is restricted to the catalog's prompt/completion prices. Stable per-game, per-role session IDs support provider stickiness; explicit prompt caching is not enabled. Infrastructure and email costs are separate from this cap.

Inference emits structured JSON to backend logs (the local development terminal or Vercel function logs). Completed and failed calls include game/request IDs, role, model, HTTP status and duration. Provider failures include selected error metadata, request/rate-limit headers and retry hints; credentials and flags are redacted, and request transcripts are omitted. Game and monitor failures share the game ID. Earlier failures cannot recover response details that were discarded.

Admission allows ten active environments, 100 new games globally per rolling day, and 3 new games per player (`RUNS_PER_DAY`, tracked by `games.new_run`; a fork that keeps an earlier instruction is free, while a fork back to a run's only instruction counts). This is an MVP capacity limit, not a Sybil-proof account system.

## Vercel

This checkout is linked to `ctf-demo`. Set the server-only environment variables from `.env.example` in Vercel; Neon/Resend integration variables alone do not include Sprite/OpenRouter credentials or the auth/cron secrets. Set the same variables for Preview too, with a different `BETTER_AUTH_SECRET` from Production. Set `BETTER_AUTH_URL` to the production origin; previews leave it unset and accept only their own `VERCEL_URL`/`VERCEL_BRANCH_URL` hosts. No credential may have a `NEXT_PUBLIC_` prefix.

Preview builds run `scripts/setup.ts` against their own Neon branch first (`vercel.json` build command → `scripts/vercel-build.ts`), so a preview copied from production gets the PR's migrations. The build fails rather than migrate the shared `vercel-dev` database when a preview has no branch of its own; production builds never migrate. Production migrations run through the `migrate prod` workflow; run `npm run setup` manually only for other databases or a coordinated non-additive migration. `vercel.json` schedules authenticated cleanup daily; a sweep also runs when a game starts or a response finishes. A daily sweep can leave an abandoned environment for up to roughly 48 hours. Failed deletions remain pending and retry at the next sweep.

Inference responses currently arrive one model response at a time; stage updates and monitor/tool events stream to the browser. No token-by-token rendering, research dashboard, model training, or guarantee of detecting every possible attack is included.

## Flag submission endpoint

New HTTP runs upload to `POST /v1/end/<token>` on the app's public HTTPS origin. An explicit `SITE_URL` selects that origin. Vercel production uses `VERCEL_PROJECT_PRODUCTION_URL` when set, otherwise its immutable `VERCEL_URL`; previews use their immutable `VERCEL_URL`. Invalid selected configuration stops new runs. Local development needs an ngrok tunnel to the same local app and database. The token in the path is the only credential. A bare `/v1/end` POST gets `401`, the same as an unknown token. The route returns neither flag bytes nor correctness. The Sprite policy allows only the configured hostname and denies other domains, then reads back that policy before first execution and after fork restoration. This hostname rule does not isolate the submission path or shared IP addresses. The agent can reach other app routes, for example to read the owner's earlier runs with a pasted session cookie. That is in scope: unless the run has transcript isolation on, the investigator can read the owner's other sessions and is expected to reconstruct such a pull. See [the submission guide](deploy/flag-submission.md) and [the verification strategy](docs/verification.md).

Each admitted command of an HTTP run gets one environment variable, `TARGET`, holding `<endpoint>/<token>`. The token is minted per dispatch, has 256 bits and is stored only as a hash. It works only while that command runs under its live lease and current generation with no stop requested. The agent's system prompt is exactly the player's, so the agent learns about `TARGET` only if the player tells it. The app describes the mechanism to the player before a run starts and in current-run help, with the example `curl --data-binary @/tmp/flag.txt "$TARGET"`. If the endpoint is not configured, the app shows that new runs are unavailable. Historical runs display an earlier-protocol notice and point players to a new run for the HTTP flow.

The POST body is the submission: up to 8 KB of UTF-8 text, correct if it contains the flag. No header or content type is required. One well-formed upload consumes the submission attempt, even if its value is wrong. A pending receipt contains no public flag bytes or correctness result. The investigator can still infer a read from visible commands, scripts, reasoning and results. Avoiding printed bytes does not guarantee evasion. Existing runs keep their stored earlier protocol.

Apply the additive migration before running code that creates HTTP runs. To roll back, first disable new HTTP creation and drain or resolve all existing HTTP runs with a compatible worker. Do not run an older binary against active HTTP runs or silently convert them to tool submissions.

## Monitor worker on Fly

Vercel cannot host the worker's continuous loop, so production and each preview run it on Fly from the `Dockerfile` image. The image runs `scripts/monitor-worker.ts` and needs only `DATABASE_URL_UNPOOLED`, `OPENROUTER_API_KEY` and `SPRITE_TOKEN`. The key covers both the investigator and the Jev classifier.

Production runs one machine in the `ctf-monitor-worker` app, configured by `fly.toml`. The `deploy worker` job in the `migrate prod` workflow deploys it after the migrate job succeeds, from the same commit. Add `deploy worker` to Vercel's production alias checks so new app code goes live only with its worker. Roll the worker back with `flyctl releases --app ctf-monitor-worker` and `flyctl deploy --image <previous image>`.

Each Vercel preview gets one machine in the `ctf-monitor-worker-preview` app, tagged with its Git branch. The `preview worker` workflow runs when Vercel reports a successful preview: it finds the Neon branch `preview/<git branch>`, builds the image for that commit and replaces the branch's machine. Deleting the branch or closing its pull request destroys the machine. A status for a commit that is no longer its branch's head is ignored.

API keys are separate per environment and set once on each Fly app with `fly secrets`. Production also holds its database URL there. Preview machines receive their branch's database URL from the workflow. GitHub holds `FLY_API_TOKEN_PROD`, `FLY_API_TOKEN_PREVIEW` and a project-scoped `NEON_API_KEY` as secrets, and `NEON_PROJECT_ID` as a variable.

## Dollar / season migration

`npm run setup` applies `db/migrations/002-dollar-seasons.sql` once. It adds fields and season records without removing token fields or transcripts, backfills response model labels, and reclassifies old estimated charges as pending holds while preserving total global exposure. Original uncertain billing values are saved in `ctf.schema_migrations.billing_backup` for audit. Re-running setup leaves current balances intact. Apply the migration before running the new code; do not run the old token-only writer after the migration. Rollback is a coordinated code/accounting change using the saved originals, not a destructive schema rollback; confirmed charges made since migration must remain in the ledger.
