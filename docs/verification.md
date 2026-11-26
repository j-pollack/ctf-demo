# Verification

Use Node 24 and install the locked dependencies with `npm ci`. Pull requests and pushes to `main` run offline checks, deterministic integration tests, browser tests, and a production build. The build step supplies synthetic environment values. See the [CI workflow](../.github/workflows/ci.yml) for the complete environment.

## Local checks

| Change                                                  | Command                                                         | What it checks                                                                                                                                                                                            |
| ------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Any offline change                                      | `npm run check`                                                 | Oxlint, Oxfmt, generated Next.js types, TypeScript, and the top-level Node test suite.                                                                                                                    |
| Database, route, worker, or service orchestration       | `npm run test:integration`                                      | Real application components against disposable Postgres, with controlled responses at external service boundaries.                                                                                        |
| Monitor stream deadlines                                | `npm run test:integration:timing`                               | Production timeouts with synthetic providers. An idle stream times out while a stream making progress can complete.                                                                                       |
| Test coverage                                           | `npm run test:coverage` and `npm run test:integration:coverage` | Separate c8 reports for offline and integration tests.                                                                                                                                                    |
| Pages, client components, sign-in, cookies or redirects | `npm run test:e2e`                                              | Chromium against a local build, with Resend, Fastmail and the display-name check faked, through sign-in, display name, email change, page loads, contact, report, game rules, feedback replies and admin. |
| Build or deployment configuration                       | `npm run build`                                                 | The Next.js production bundle.                                                                                                                                                                            |

The pre-commit hook checks staged files with lint-staged, then runs typechecking and offline tests on the working tree. To fix formatting or lint failures, run `npm run format` or `npm run lint:fix`, review the changes, and stage the intended files. See the [hook](../.husky/pre-commit) and [package scripts](../package.json).

## Integration setup

Start Docker and prepare both images from the repository root before running the full suite.

```sh
docker pull postgres:18-alpine
docker build -t ctf-flag-read-sprite:1 evals/flag-read
npm run test:integration
```

The runner selects `tests/integration/*.test.ts` by default. For a focused check, pass an existing test path, for example `npm run test:integration -- tests/integration/game-rules.test.ts`. It starts a fresh Postgres container on a random loopback port, passes synthetic credentials to the tests, and removes the container on exit or handled interruption. It does not load `.env.local`. The reporter prints a test file's captured process output on failure. See the [integration runner](../scripts/test-integration.ts).

## Browser test setup

The browser tests need Docker, the `postgres:18-alpine` image and Chromium. Install Chromium once with `npx playwright install chromium`.

`npm run test:e2e` builds the app, starts it with `next start` and runs `tests/e2e/*.test.ts` against a disposable Postgres container. A Node preload answers Resend, Fastmail and the display-name check from the integration suite's fakes. The preload rejects every other `fetch` to a host that is not loopback and records it as a violation. The runner fails the run when a violation is left unexplained or the server log holds a failure event, which is a JSON line whose `event` ends in `failed` or is `auth.background_task_unawaited`. Each journey also fails on a failure event the server logged during it, unless the journey declares it with `expectServerFailure`.

Three journeys cover the account and admin stories. A member changes their email through the link to the old address and then the link to the new one. An admin switches the game-rule toggles and visitors see the changed rule copy. An admin replies by mail to a contact message, which is read back from the recorded Fastmail mail and the thread page, then closes and reopens it.

A failing journey leaves a trace and a screenshot in `.artifacts/e2e/`. The server log and the captured mail are written there too.

## Writing tests

- Keep unit tests independent of databases, network access, SDK sessions, and credentials. Use the offline suite for pure logic and in-process component checks such as React rendering.
- Exercise owned behavior through its normal entry points. For an HTTP change, check the real route's status, cookies or stream, and resulting stored state. For a billing change, use real Postgres transactions to check admission, settlement, refunds, and retries. Concurrency tests must show both successful admissions and enforcement of the limit.
- Stub external OpenRouter, Resend, Fastmail, and Sprite operations at their service boundaries. Fakes must validate requests and fail on unexpected operations. Use the real auth, lease, billing, monitor parsing, and transcript code. Cover failures, timeouts, aborts, and cleanup when the affected operation supports them.
- Add a regression for each changed behavior. Exercise deployment-specific assumptions such as email delivery and Sprite network policy against the real service before promotion. The [repository instructions](../AGENTS.md) define the testing policy.

Coverage includes unimported runtime files under `app/` and `lib/`. The type-only `lib/types.ts` is excluded. The offline and integration summaries are written under `coverage/` and `coverage/integration/`. To calculate combined coverage, merge the raw execution data before reporting percentages. The project has no enforced numeric coverage threshold. For the September 2026 measurements, use `git show 68f4035:docs/verification.md`.

## Deployment checks

Use a dedicated test database, disposable accounts and resources, and capped provider spend. The auth, budget, display-name, and game smoke npm scripts load `.env.local`. Configure those values for the isolated test environment before invoking them. A feature worktree can inherit credentials pointing to a shared database.

| Command                                                   | Scope                                                                                                                                                                      |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check:auth`                                      | Exercises real Better Auth handlers, closed guest sign-in, legacy guest-run transfer, single-use magic links, and leaderboard privacy. Captures outbound email locally.    |
| `npm run check:budget`                                    | Exercises concurrent reservations, settlement, refunds, reconciliation, and session leases against the configured database.                                                |
| `CTF_SMOKE_DISPOSABLE=1 npm run smoke -- --messages-only` | Uses real Sprites and Postgres with controlled model responses for session switching, billing, worker review, and cleanup.                                                 |
| `CTF_SMOKE_DISPOSABLE=1 npm run smoke`                    | Adds live model inference, streamed usage, and one real monitor catch through the worker. Live monitor error handling and harmless-run approval require separate evidence. |
| `npm run smoke:display-name`                              | Sends two paid Jev requests outside the app's daily cap to check the display-name moderation contract.                                                                     |

Both game smoke modes require a freshly migrated database with empty run, spend, and job tables. They create remote resources and can retain historical records. Use the separate [flag submission guide](../deploy/flag-submission.md) for the receipt smoke's explicit environment, replay and cleanup checks, and deployed ingress and egress checks.

The browser tests do not cover starting a run, streamed output, the monitor worker, real mail delivery or the deployed site. Before promotion, exercise a member's path in the deployed browser with a test inbox. Verify magic-link delivery and sign-in, start a run, observe streamed output, reload it, and confirm the pending and terminal states. Send one message from `/contact` while signed out and one report from the run's Report button, then confirm that both appear on `/admin` and that the report carries the run and session ids. Delete the two rows afterwards. Record the deployment, provider results, spend, and cleanup. The backend smoke scripts call application functions directly, so browser and inbox behavior require their own checks.
