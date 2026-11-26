# Deployment and operations

## Environment

| Service               | Configuration                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vercel                | Set the server-only values in [.env.example](../.env.example) for Production and Preview, except `FASTMAIL_API_TOKEN` and `CONTACT_EMAIL`, which are Production only. Give Preview a separate `BETTER_AUTH_SECRET`. Set `BETTER_AUTH_URL` to the production origin in Production. Leave it unset in Preview so Better Auth accepts the deployment and branch hosts supplied by Vercel. Keep credentials out of `NEXT_PUBLIC_` variables.                                                                                                                                                                               |
| Production Fly worker | Set `DATABASE_URL_UNPOOLED`, `SPRITE_TOKEN` and `OPENROUTER_API_KEY` as Fly secrets on `ctf-monitor-worker`. The worker shares the web app’s database and inference ledger.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Fastmail mail         | Set `FASTMAIL_API_TOKEN` and `CONTACT_EMAIL` for Production only, so previews send nothing. The token needs the Email and Email submission scopes and can read and send all mail in its Fastmail account. Before promoting a change to the mail code, run `npm run smoke:fastmail -- send <outside address>`. It sends the notification, then a reply to that address, and prints a thread id. Reply to that mail from the outside account, which must not be on this Fastmail account. Then run `npm run smoke:fastmail -- read <thread id>`, which fails with the condition that does not hold. It never runs in CI. |
| Preview Fly workers   | Set preview Sprite and OpenRouter credentials on `ctf-monitor-worker-preview`. The workflow supplies each machine with its Neon branch’s direct database URL.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| GitHub Actions        | Set production migration secrets `DATABASE_URL_UNPOOLED`, `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL`. Optionally set `ADMIN_EMAILS`. Worker deployment uses secrets `FLY_API_TOKEN_PROD`, `FLY_API_TOKEN_PREVIEW` and project-scoped `NEON_API_KEY`, plus the variable `NEON_PROJECT_ID`.                                                                                                                                                                                                                                                                                                                              |

Both Fly apps need public addresses for authenticated wake requests. For each app, allocate any missing addresses with `fly ips allocate-v4 --shared -a <app>` and `fly ips allocate-v6 -a <app>`. The web app’s public flag receiver has separate origin, egress and rate-limit requirements. [Flag submission guide](flag-submission.md)

## Release order

1. GitHub Actions runs `ci` on pull requests and pushes to `main`. It runs offline checks, disposable Postgres integration tests and a production build with synthetic settings. Run the approved real-service and browser checks separately before promotion. [CI workflow](../.github/workflows/ci.yml) · [Verification guide](../docs/verification.md)
2. After a successful push build on `main`, the `migrate prod` job checks out that SHA and runs setup against production. Production migrations run serially while the previous release serves traffic. Keep automatic migrations compatible with the serving release. Coordinate destructive schema or accounting changes separately. [Production workflow](../.github/workflows/migrate-prod.yml)
3. The `deploy worker` job builds the same SHA, drains the old machine and releases the image. Configure Vercel’s **production alias** to wait for `ci`, `migrate prod` and `deploy worker`. Check those gates in Vercel before promotion. The GitHub workflows define the jobs, while Vercel controls the alias. [Fly configuration](../fly.toml)

A Vercel preview build migrates its own Neon branch before building. Setup fails if the URL points at the known shared `vercel-dev` endpoint. After a successful preview, the worker workflow looks up `preview/<git branch>`, verifies the commit is still a branch head and replaces that branch’s machine. When branches share a head, it selects the first matching non-main branch. Closing a same-repository pull request or deleting its branch removes the tagged machine. [Preview build](../scripts/vercel-build.ts) · [Preview worker workflow](../.github/workflows/preview-worker.yml)

## Migrations and rollback

Use `npm run setup` for a designated local database. The deployment jobs invoke the same script with their environment’s credentials. Setup applies the schema and SQL files in dependency order, backfills transcript search data and runs Better Auth’s migrations. Use the script as the migration manifest. [Setup script](../scripts/setup.ts) · [SQL migrations](../db/migrations/)

| Migration                          | Deployment dependency                                                                                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `020` through `025`                | The HTTP receipt route and worker need the submission, game-rule, annotation, text-screen and returned-command fields. Migration 025 adds jailbreak catches and refused texts. |
| `026` through `029`                | The worker records forced decisions, requeues, prompt hashes, continuations and read confirmations.                                                                            |
| `030-inference-game-unsettled.sql` | Adds the index used to sum outstanding reservations for a run.                                                                                                                 |
| `031-monitor-routing.sql`          | Adds the review route and job final version. The worker requeues caught-up jobs on already-finalizing runs for final review.                                                   |
| `032-second-look.sql`              | Adds the fields that store second-look decisions.                                                                                                                              |
| `033-display-name.sql`             | Runs after Better Auth creates its tables. Adds unique display names and account-level inference records.                                                                      |
| `034-investigator-requests.sql`    | Stores each investigator request for transcript inspection.                                                                                                                    |
| `035-feedback.sql`                 | Stores contact messages and in-run reports. The contact route and the Report button need it.                                                                                   |
| `036-feedback-mail.sql`            | Adds the Fastmail thread id and the closed time to feedback. The admin message pages need it.                                                                                  |

If a migration fails, fix it before promoting. For a code regression, select a compatible previous Vercel deployment and Fly image. Reserve Neon point-in-time restore for data recovery. Check the following boundaries before rolling back.

- Stop creating HTTP or asynchronous runs before reverting to code that predates them. Let a compatible worker finish pending reviews and submissions, or preserve the unresolved status of affected runs. Keep their stored submission transport. If the reverted app predates worker wake requests, pair it with a compatible polling worker.
- Code before `009-monitor-choice` expects a season ID. End active or creating seasonless runs before reverting that far. Their pages remain unreadable to that version.
- Migration `002-dollar-seasons` preserves the old uncertain charges in `ctf.schema_migrations.billing_backup`. Coordinate any return to a token-based writer with ledger reconciliation. Preserve confirmed charges recorded since migration.

## Worker health and draining

The worker registers its wake URL, machine ID and bearer token in the `worker_wake` row of `ctf.settings`. Keep that registration server-side. A queued job wakes the worker via `POST /wake` on Fly’s HTTPS endpoint, forwarded to port 8080. Up to four loops claim independent reviews. They poll for ten minutes after startup, poll after wakes, then sleep without querying Postgres. A pass every six hours recovers missed wakes. [Worker entry point](../scripts/monitor-worker.ts) · [Polling intervals](../lib/monitor-worker-loop.ts)

Both deployment workflows send an authenticated `POST /drain` before replacing a machine. The worker finishes in-flight reviews and removes its registration. The drain script checks the registered origin and waits up to 12 minutes for the registration to change. A failed initial database read fails the job. A skipped drain, HTTP failure or timeout is logged and deployment can continue. Inspect the drain result before a manual replacement. [Drain script](../scripts/drain-worker.ts)

For a manual production rollback, identify the previous image with `flyctl releases --app ctf-monitor-worker`. With the production database selected, run `node --import tsx scripts/drain-worker.ts https://ctf-monitor-worker.fly.dev`. After the drain, run `flyctl deploy --app ctf-monitor-worker --image <previous-image>`. A direct machine restart can interrupt reviews. A drained worker waits for termination and exits with an error after 15 minutes if the deploy stalls, allowing Fly to restart it.

## Administrator access

Members with `isAdmin` can view usage, signups and spend at `/admin`, select the attacker model and configure game rules. Other users receive a 404. An admin bypasses the personal new-run limit. Shared capacity and spending checks still apply.

To grant access, have the member sign in, add their email to comma-separated `ADMIN_EMAILS` in the setup environment, and rerun setup. Setup trims whitespace, ignores case and grants only existing non-guest accounts. For a manual grant or revocation, update `ctf."user"."isAdmin"` by email. Before revoking, remove the email from every setup environment so the next setup cannot re-grant it. To list all grants, including manual ones, run

```sql
SELECT id, email, name
FROM ctf."user"
WHERE "isAdmin" AND "isAnonymous" IS NOT TRUE
ORDER BY email;
```

## Capacity, billing and investigation

| Scope           | Admission rule                                                                                                                            |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Game creation   | Up to ten active environments and 100 new runs per rolling 24 hours. Each non-admin member can start three new runs in that window.       |
| Player          | Each new run has $0.50 for agent inference and in-session text screening. Outstanding holds reduce the available balance.                 |
| Monitor         | New monitor requests stop once settled monitor spend reaches $1.50. Finalizing a run allows another $1.00 of monitor spend.               |
| Daily inference | All roles share a $10 cap per UTC day. Admission reserves an upper bound before dispatch. Infrastructure and email are billed separately. |

OpenRouter usage settles the actual charge and releases the unused reservation. Jev calls use reported input tokens at a fixed rate. Known unbilled rejections release the hold. For a pending call with a generation ID, cleanup queries OpenRouter for the final charge. A failed completion with no generation ID can settle at its ceiling immediately. Cleanup settles outstanding unverifiable holds at their ceiling after 24 hours and marks them estimated. [Budget policy](../lib/policy.ts) · [Settlement and cleanup](../lib/games.ts)

Use the game and request IDs to correlate inference errors across web and worker logs. The inference logger includes model, role, duration and selected provider error details and redacts credentials and flags. To inspect stored investigator messages, set `DATABASE_URL` for the intended database and run `node --import tsx scripts/investigator-transcript.ts <review-or-game-uuid>`. [Transcript reader](../scripts/investigator-transcript.ts)

Game starts and completed responses trigger cleanup. Vercel also schedules an authenticated sweep daily at 09:00 UTC. An active game becomes eligible for expiry after 24 idle hours. If the daily sweep is the next trigger, an abandoned Sprite can survive for nearly 48 hours. Failed deletions remain eligible for retry. [Cron configuration](../vercel.json)
