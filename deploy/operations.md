# Deployment and operations

## Environment

| Service               | Configuration                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vercel                | Set the server-only values in [.env.example](../.env.example) for Production and Preview, except `FASTMAIL_API_TOKEN` and `CONTACT_EMAIL`, which are Production only. Give Preview a separate `BETTER_AUTH_SECRET`. Set `BETTER_AUTH_URL` to the production origin in Production. Leave it unset in Preview so Better Auth accepts the deployment and branch hosts supplied by Vercel. Keep credentials out of `NEXT_PUBLIC_` variables.                                                                                                                                                                                                                                                                                                                                                 |
| Production Fly worker | Set `DATABASE_URL_UNPOOLED`, `SPRITE_TOKEN` and `OPENROUTER_API_KEY` as Fly secrets on `ctf-monitor-worker`. The worker shares the web app’s database and inference ledger.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Fastmail mail         | Set `FASTMAIL_API_TOKEN` and `CONTACT_EMAIL` for Production only, so previews send nothing. The token needs the Email and Email submission scopes and can read and send all mail in its Fastmail account. Before promoting a change to the mail code, run `npm run smoke:fastmail -- send <outside address>`. It sends the notification, then a reply to that address, and prints a thread id. Reply to that mail from the outside account, which must not be on this Fastmail account. Then run `npm run smoke:fastmail -- read <thread id>`, which fails with the condition that does not hold. Then run `npm run smoke:fastmail -- reply <thread id> <outside address>`, which sends a second reply the way the panel does and checks that it joined the thread. It never runs in CI. |
| Preview Fly workers   | Set preview Sprite and OpenRouter credentials on `ctf-monitor-worker-preview`. The workflow supplies each machine with its Neon branch’s direct database URL.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| GitHub Actions        | Set production migration secrets `DATABASE_URL_UNPOOLED`, `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL`. Optionally set `ADMIN_EMAILS`. Worker deployment uses secrets `FLY_API_TOKEN_PROD`, `FLY_API_TOKEN_PREVIEW` and project-scoped `NEON_API_KEY`, plus the variable `NEON_PROJECT_ID`. The `promote` job uses the secret `VERCEL_TOKEN` and the variables `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` and `PRODUCTION_ORIGIN`.                                                                                                                                                                                                                                                                                                                                                               |

Both Fly apps need public addresses for authenticated wake requests. For each app, allocate any missing addresses with `fly ips allocate-v4 --shared -a <app>` and `fly ips allocate-v6 -a <app>`. The web app’s public flag receiver has separate origin, egress and rate-limit requirements. [Flag submission guide](flag-submission.md)

## Release order

1. GitHub Actions runs `ci` on pull requests and pushes to `main`. It runs offline checks, disposable Postgres integration tests and a production build with synthetic settings. A second job, `e2e`, drives Chromium against a locally started build with faked Resend and display-name services. Run the approved real-service and deployed-browser checks separately before promotion. [CI workflow](../.github/workflows/ci.yml) · [Verification guide](../docs/verification.md)
2. After a successful push build on `main`, the `migrate prod` job checks out that SHA and runs setup against production. The `ci` workflow must pass first, including its `e2e` job. Production migrations run serially while the previous release serves traffic. Keep automatic migrations compatible with the serving release. Keep the worker compatible with the previous web release too, because a release that stops before promotion leaves the new schema and worker under the old web deployment. Coordinate destructive schema or accounting changes separately. [Production workflow](../.github/workflows/migrate-prod.yml)
3. The `deploy worker` job builds the same SHA, drains the old machine and releases the image. [Fly configuration](../fly.toml)
4. The `promote web` job finds the production deployment Vercel built for the SHA and waits for it to be ready. It reads which deployment serves the production domain and refuses to continue when that deployment's commit is not an ancestor of the new commit or cannot be read. It then sends read-only requests to the new deployment's own URL. The pages `/`, `/rules`, `/rank`, `/contact` and `/signin` must answer 200 with their page test id in the HTML. `/api/leaderboard` must answer 200 with an `entries` array, `GET /v1/end` must answer 405, and an unauthenticated `POST /v1/end` must answer 400 there. When those pass, it runs `vercel promote`, reads the domain again and repeats the checks on the production origin, where `POST /v1/end` must answer 401. If the promotion does not finish or the live checks fail, it runs `vercel rollback` to the deployment that served before and the job fails. This needs Vercel's **Auto-assign Custom Production Domains** setting turned off, so a push to `main` builds a production deployment and leaves it staged. While the setting is on, Vercel moves the domain itself and the job reports `already-serving`. [Release scripts](../scripts/release-deployment.ts) · [Release checks](../scripts/release-check.ts)

A Vercel preview build migrates its own Neon branch before building. Setup fails if the URL points at the known shared `vercel-dev` endpoint. After a successful preview, the worker workflow looks up `preview/<git branch>`, verifies the commit is still a branch head and replaces that branch’s machine. When branches share a head, it selects the first matching non-main branch. Closing a same-repository pull request or deleting its branch removes the tagged machine. [Preview build](../scripts/vercel-build.ts) · [Preview worker workflow](../.github/workflows/preview-worker.yml)

### Finishing, repeating or undoing a release

- **Finish a stopped release.** Fix the cause, open the workflow run and choose **Re-run failed jobs**. Do not choose **Re-run all jobs**, which drains and redeploys the worker. The `promote web` job also reads the production domain again, so a release that was promoted meanwhile reports `already-serving`. To finish by hand, take the deployment URL from the `new_url` line in the log of the step "Find the new deployment and decide", run `node --import tsx scripts/release-check.ts <deployment URL> deployment`, and then run `vercel promote <deployment URL> --scope <team>`. The next good release also replaces a stopped one, because it promotes its own build.
- **Re-run an older release.** Re-running `promote web` for an older release after a newer release stopped before promotion puts the older web code under the newer schema and worker. The compatibility rules above cover this case. If a newer commit already serves, the job refuses.
- **When the job reports `already-serving` and a check fails.** The new build went live without this run, so the site is broken now. The job summary names the serving deployment id. Roll back by hand as described below, using the id of the last good deployment from Vercel's deployment list.
- **Undo a release.** Roll the worker back as described under migrations and rollback. The migration stays. Roll the web deployment back with `vercel rollback <deployment id or url> --scope <team>`, taking the id from Vercel's deployment list.
- **What a web rollback leaves in place.** It moves the production domain only. The migration and the worker image stay as they are. A rollback turns automatic domain assignment off for the project, and the next promote turns it back on. After any rollback, the next release's promote may therefore leave automatic assignment on. Vercel then promotes first again and the job reports `already-serving`. Read the setting after a rollback and again after the release that follows it.

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
| `035-review-effort.sql`            | Adds the investigator reasoning effort that each review ran with.                                                                                                              |
| `036-feedback.sql`                 | Stores contact messages and in-run reports. The contact route and the Report button need it.                                                                                   |
| `037-feedback-mail.sql`            | Adds the Fastmail thread id and the closed time to feedback. The admin message pages need it.                                                                                  |

If a migration fails, fix it before promoting. For a code regression, select a compatible previous Vercel deployment and Fly image. Reserve Neon point-in-time restore for data recovery. Check the following boundaries before rolling back.

- Stop creating HTTP or asynchronous runs before reverting to code that predates them. Let a compatible worker finish pending reviews and submissions, or preserve the unresolved status of affected runs. Keep their stored submission transport. If the reverted app predates worker wake requests, pair it with a compatible polling worker.
- Code before `009-monitor-choice` expects a season ID. End active or creating seasonless runs before reverting that far. Their pages remain unreadable to that version.
- Migration `002-dollar-seasons` preserves the old uncertain charges in `ctf.schema_migrations.billing_backup`. Coordinate any return to a token-based writer with ledger reconciliation. Preserve confirmed charges recorded since migration.

## Worker health and draining

The worker registers its wake URL, machine ID and bearer token in the `worker_wake` row of `ctf.settings`. Keep that registration server-side. A queued job wakes the worker via `POST /wake` on Fly’s HTTPS endpoint, forwarded to port 8080. Up to four loops claim independent reviews. They poll for ten minutes after startup, poll after wakes, then sleep without querying Postgres. A pass every six hours recovers missed wakes. [Worker entry point](../scripts/monitor-worker.ts) · [Polling intervals](../lib/monitor-worker-loop.ts)

Both deployment workflows send an authenticated `POST /drain` before replacing a machine. The worker finishes in-flight reviews and removes its registration. The drain script checks the registered origin and waits up to 12 minutes for the registration to change. A failed initial database read fails the job. A skipped drain, HTTP failure or timeout is logged and deployment can continue. Inspect the drain result before a manual replacement. [Drain script](../scripts/drain-worker.ts)

For a manual production rollback, identify the previous image with `flyctl releases --app ctf-monitor-worker`. With the production database selected, run `node --import tsx scripts/drain-worker.ts https://ctf-monitor-worker.fly.dev`. After the drain, run `flyctl deploy --app ctf-monitor-worker --image <previous-image>`. A direct machine restart can interrupt reviews. A drained worker waits for termination and exits with an error after 15 minutes if the deploy stalls, allowing Fly to restart it.

## Administrator access

Members with `isAdmin` can view usage, signups and spend at `/admin`, select the attacker model, configure game rules and change the budgets and limits in the capacity table below. Other users receive a 404. An admin bypasses the personal new-run limit. Shared capacity and spending checks still apply.

The Budgets and limits card at `/admin` holds thirteen values: the shared daily cap, the run budget, new runs per member, new runs for all players, the monitor allowance per run, the final review allowance per run, environments open at once, name checks per member per day, sessions per run, auto-continue turns, the response time limit, the attacker reasoning effort and the investigator reasoning effort. The values in the capacity table are the defaults. Each field accepts a range fixed in code, so a form typo cannot remove a spending limit. A change applies from the next request, and a run keeps the budget it started with. The monitor worker reads the same settings live once it runs this release, so a change needs no worker redeploy. A worker built before this release keeps the defaults. Lowering a monitor allowance below what a run under final review has already spent ends that run with no result.

A run that already has more sessions than a lowered session limit keeps them and cannot add another. The attacker effort applies to every new run and to each session's next instruction. The investigator effort applies to each review that starts afterwards, and the review records the effort it ran with in `ctf.monitor_reviews.investigator_effort`. The leaderboard filters on the monitor version and the game rules only, so it ranks wins under different investigator efforts together. The evals in the repository describe the effort `high` only.

To grant access, have the member sign in, add their email to comma-separated `ADMIN_EMAILS` in the setup environment, and rerun setup. Setup trims whitespace, ignores case and grants only existing non-guest accounts. For a manual grant or revocation, update `ctf."user"."isAdmin"` by email. Before revoking, remove the email from every setup environment so the next setup cannot re-grant it. To list all grants, including manual ones, run

```sql
SELECT id, email, name
FROM ctf."user"
WHERE "isAdmin" AND "isAnonymous" IS NOT TRUE
ORDER BY email;
```

## Setting fallbacks and the deploy check

Each of the thirteen settings reads a stored admin value first. Without one, it reads an environment variable named `CTF_` followed by the key in upper case. Without a valid variable, it uses the default in the code. A stored value or variable that is not valid for its field is skipped. Money is whole microdollars, a count is a whole number and an effort is one of `low`, `medium` and `high`.

| Variable                                  | Default    | Format                  |
| ----------------------------------------- | ---------- | ----------------------- |
| `CTF_DAILY_CAP_MICRODOLLARS`              | `10000000` | microdollars            |
| `CTF_RUN_BUDGET_MICRODOLLARS`             | `500000`   | microdollars            |
| `CTF_RUNS_PER_DAY`                        | `3`        | count                   |
| `CTF_TOTAL_RUNS_PER_DAY`                  | `100`      | count                   |
| `CTF_MONITOR_RUN_ALLOWANCE_MICRODOLLARS`  | `1500000`  | microdollars            |
| `CTF_FINAL_REVIEW_ALLOWANCE_MICRODOLLARS` | `1000000`  | microdollars            |
| `CTF_ENVIRONMENTS_OPEN`                   | `10`       | count                   |
| `CTF_NAME_CHECKS_PER_DAY`                 | `20`       | count                   |
| `CTF_SESSIONS_PER_RUN`                    | `8`        | count                   |
| `CTF_AUTO_CONTINUE_TURNS`                 | `8`        | count                   |
| `CTF_RESPONSE_SECONDS`                    | `230`      | count                   |
| `CTF_AGENT_EFFORT`                        | `low`      | `low`, `medium`, `high` |
| `CTF_INVESTIGATOR_EFFORT`                 | `high`     | `low`, `medium`, `high` |

The web app reads the variables from Vercel and the worker reads them from Fly secrets. With no stored value, the two can differ if their variables differ.

When the settings cannot be read, the landing page and every page under the game layout still render, from the environment values and the defaults. In a real database outage they wait first for the connection pool's 10 second timeout. The play UI then uses the environment value for the session limit and has auto-continue off until the tab reloads. The fallback covers those pages only. No run can start and no spend can be reserved without the database, so the routes, the admin page and the worker do not fall back.

The Vercel build fails before it migrates or builds when `VERCEL_ENV` is `production` or `preview` and any of the thirteen variables is missing or invalid, and the error names each one. The worker workflows run `flyctl secrets list` for the Fly app and fail before the drain when a name is absent. Fly does not show secret values, so that check proves the names and not the values. A worker with an invalid value uses the default for that key. A manual `flyctl deploy` and a Vercel promote or rollback of an existing build pass through neither check. [Vercel build check](../scripts/vercel-build.ts) · [Worker check](../scripts/check-limit-env.ts)

Once this release merges, a Vercel build and a worker deploy fail until the thirteen variables exist in Vercel Production and Preview and on both Fly apps, so set them first. To set the variables, add each one to Vercel for Production and Preview and set all thirteen on both Fly apps. The `--stage` flag stores the secrets without restarting the machines, so the next deploy picks them up.

```sh
for target in production preview; do
  grep '^CTF_' .env.example | while IFS='=' read -r name value; do
    printf '%s' "$value" | vercel env add "$name" "$target" --yes
  done
done

flyctl secrets set --stage --app ctf-monitor-worker \
  CTF_DAILY_CAP_MICRODOLLARS=10000000 CTF_RUN_BUDGET_MICRODOLLARS=500000 \
  CTF_RUNS_PER_DAY=3 CTF_TOTAL_RUNS_PER_DAY=100 \
  CTF_MONITOR_RUN_ALLOWANCE_MICRODOLLARS=1500000 CTF_FINAL_REVIEW_ALLOWANCE_MICRODOLLARS=1000000 \
  CTF_ENVIRONMENTS_OPEN=10 CTF_NAME_CHECKS_PER_DAY=20 CTF_SESSIONS_PER_RUN=8 \
  CTF_AUTO_CONTINUE_TURNS=8 CTF_RESPONSE_SECONDS=230 CTF_AGENT_EFFORT=low \
  CTF_INVESTIGATOR_EFFORT=high
```

Run the `flyctl` command a second time with `--app ctf-monitor-worker-preview`.

## Capacity, billing and investigation

| Scope           | Admission rule, at the defaults                                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Game creation   | Up to ten active environments and 100 new runs per rolling 24 hours. Each non-admin member can start three new runs in that window.       |
| Sessions        | A run can have up to eight sessions. The play UI continues a stopped response on its own for up to eight turns.                           |
| Name checks     | Each member can check 20 display names per UTC day. A check is an inference call under the shared daily cap.                              |
| Reasoning       | The attacker reasons at the effort `low` and the investigator at `high`.                                                                  |
| Player          | Each new run has $0.50 for agent inference and in-session text screening. Outstanding holds reduce the available balance.                 |
| Monitor         | New monitor requests stop once settled monitor spend reaches $1.50. Finalizing a run allows another $1.00 of monitor spend.               |
| Daily inference | All roles share a $10 cap per UTC day. Admission reserves an upper bound before dispatch. Infrastructure and email are billed separately. |

An admin can change every figure in this table. The bounds are $0 to $100 for the daily cap, $0.01 to $5 for the run budget, 1 to 50 for new runs per member, 0 to 10,000 for new runs for all players, $0.10 to $10 for the monitor allowance, $0 to $10 for the final review allowance, 1 to 50 environments, 1 to 200 name checks, 1 to 32 sessions, 0 to 50 auto-continue turns and 5 to 230 seconds for the response time limit. A value of zero turns auto-continue off. Values far below 230 seconds are for tests. An effort is one of `low`, `medium` and `high`. The Sprites account has its own limit, which stays the real ceiling for environments.

OpenRouter usage settles the actual charge and releases the unused reservation. Jev calls use reported input tokens at a fixed rate. Known unbilled rejections release the hold. For a pending call with a generation ID, cleanup queries OpenRouter for the final charge. A failed completion with no generation ID can settle at its ceiling immediately. Cleanup settles outstanding unverifiable holds at their ceiling after 24 hours and marks them estimated. [Budget policy](../lib/policy.ts) · [Settlement and cleanup](../lib/games.ts)

Use the game and request IDs to correlate inference errors across web and worker logs. The inference logger includes model, role, duration and selected provider error details and redacts credentials and flags. To inspect stored investigator messages, set `DATABASE_URL` for the intended database and run `node --import tsx scripts/investigator-transcript.ts <review-or-game-uuid>`. [Transcript reader](../scripts/investigator-transcript.ts)

Game starts and completed responses trigger cleanup. Vercel also schedules an authenticated sweep daily at 09:00 UTC. An active game becomes eligible for expiry after 24 idle hours. If the daily sweep is the next trigger, an abandoned Sprite can survive for nearly 48 hours. Failed deletions remain eligible for retry. [Cron configuration](../vercel.json)
