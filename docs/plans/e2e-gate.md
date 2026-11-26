# Release gate, part 2a: browser suite with controlled services

Worktree: `/Users/jonathan/Code/ctf/.worktrees/e2e-gate`
Branch: `feature/e2e-gate`
Baseline: `5380b8c5` on `main`, clean tree, nothing staged.
Request: the user asked for end-to-end tests that gate deployment and agreed on 2026-11-26 to a four-part plan, published at https://artifacts.jonathanpollack.dev/a/KEZTBv9jcVBeLiMn. This contract covers the first half of part 2.

Roles: lead Claude Fable 5.2. Plan verifier and code reviewer Claude Opus, high effort, read-only. Developer Claude Sonnet, medium effort. No commit, push or merge without the user's yes.

## Problem

No test opens the app in a browser. `ci` runs lint, types, offline tests, Postgres integration tests and a production build. The integration tests import route handlers and call them in the test process. A defect in a page, a client component, a cookie, a redirect or the built bundle reaches production unseen. `docs/verification.md` lists the browser path as a manual step before promotion.

## Scope

A new command `npm run test:e2e` and a new `e2e` job in the `ci` workflow. The command builds the app, starts it with `next start` against a disposable Postgres, and drives Chromium through the journeys below. Resend and the display-name check on OpenRouter answer from a fake loaded into the server process. Any other request made through `fetch` to a host that is not loopback fails, and any `WebSocket` fails.

Stage 2a covers every journey that needs no Sprite and no monitor worker: sign-in, display name, page loads, contact, report and admin.

## Non-goals

- Run journeys: starting a run, streamed output, flag upload, monitor review, leaderboard capture. They are stage 2c, with its own contract. The section "Stage 2c constraints" records what the survey found.
- The monitor worker process. Stage 2a starts the app only.
- The real mode against deployed services, workflow-owned promotion and the ruleset change. They are parts 3, 4 and 1 of the plan.
- Failure paths of the faked services. The tests cannot reach a fake's controls inside the server process, so mail failures, rejected names and timeouts stay in the integration suite.
- Requests that bypass `fetch` and `WebSocket`, such as `node:http` or a raw socket. No application code uses them for outbound calls today.
- Browsers other than Chromium, visual comparison and retries.
- Changes to application code under `app/` and `lib/`. If a journey cannot be driven without one, the developer stops and returns to the lead.

## Evidence gathered before this contract

Two throwaway runs on 2026-11-26 in this worktree, files under the git-ignored `.artifacts/e2e-spike/`:

- `next start` serves in the process that the Node preload ran in. A preload that replaced `globalThis.fetch` received the Resend request for a magic link, and opening the captured link returned `302` with a session cookie.
- The preload can be TypeScript: `NODE_OPTIONS="--import tsx --import <preload.ts>"` loaded `createAccountFake` from `tests/integration/display-name-fake.ts` into the server and produced the same result. The preload's top level ran twice in one process id.
- The worktree has a `.env.local` with real credentials, and Next loads it on build and start. Setting each of its names in the environment first, to an empty or synthetic value, kept every file value out. The server saw zero-length `ADMIN_EMAILS`, `SITE_URL`, `FASTMAIL_API_TOKEN`, `DATABASE_URL` and `DATABASE_URL_UNPOOLED`.
- With `DATABASE_URL` and `DATABASE_URL_UNPOOLED` empty, `lib/db.ts` builds a pool from `PGHOST`, `PGPORT`, `PGUSER` and `PGDATABASE` with no forced TLS. `scripts/setup.ts` migrated the container the same way.

The plan verifier confirmed from the code that the journeys reach no other boundary while `FASTMAIL_API_TOKEN` and `CONTACT_EMAIL` are empty: `notifyFeedback` returns early without mail configuration, the model catalogue is fetched only on an agent-model change, a prompt or a new session, and the run page reaches OpenRouter only when a run has reserved spend.

## Design

1. **Runner** `scripts/test-e2e.ts`, modelled on `scripts/test-integration.ts`. Order: build, start Postgres, migrate with `scripts/setup.ts`, start the app, run `tests/e2e/*.test.ts` with the Node test runner, stop everything. It accepts optional test file paths as the integration runner does.
2. **Environment.** One exported pure function builds the environment for a child process. It starts from an allow-list of process variables, sets every name defined in any file matching `.env*` in the checkout root to the empty string, then applies the synthetic values. The script follows the `import.meta.main` pattern of `scripts/vercel-build.ts` so the function has an offline test. Fixed values:
   - `NEXT_TELEMETRY_DISABLED=1` for every child.
   - `DATABASE_URL` and `DATABASE_URL_UNPOOLED` empty, `PGHOST=127.0.0.1`, for the migration, the server and the tests. The build gets the unreachable database URL that the `ci` build step uses.
   - `SITE_URL`, `TRIPWIRE_COOKIE_PREFIX`, `FASTMAIL_API_TOKEN`, `CONTACT_EMAIL` and `ADMIN_EMAILS` empty.
   - `BETTER_AUTH_URL` and the browser's base URL are both exactly `http://127.0.0.1:<port>`.
   - `NODE_ENV` is not set to `test` for the build or the server.
   - `NODE_OPTIONS` with the preload goes to the server only.
3. **Guards before each spawn.** The runner asserts that the migration, server and test environments have an empty `DATABASE_URL` and `DATABASE_URL_UNPOOLED` and `PGHOST` equal to `127.0.0.1`, and that the build environment has the unreachable URL. A failed assertion stops the run before the child starts.
4. **Disposable Postgres.** The container start, readiness wait and removal move from `scripts/test-integration.ts` into one small shared module that both runners use. Each runner keeps its own signal handling. Behaviour of the integration runner is unchanged.
5. **Processes.** The server is spawned as `process.execPath node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port <port>`, not through npm, so a signal reaches it. The port is `PORT` when set and a free port otherwise. The signal handler stops whichever child is running: build, migration, server or tests.
6. **Preload** `tests/e2e/preload.ts`, loaded into the server with `NODE_OPTIONS`.
   - It exports a pure factory that takes the fake and a recorder and returns the `fetch` replacement. The offline test covers the factory.
   - It installs the replacement in every thread, only when the file names from the environment are set, and once per thread: a marker on `globalThis` stops a second installation from wrapping the first. The code review asked for every thread, so that a `fetch` from a worker thread is refused too. It logs `isMainThread` and `threadId` once at startup so the double evaluation is explained.
   - The replacement parses the URL. It passes a request through when the protocol is `http:` and the hostname is exactly `127.0.0.1`. It hands Resend and the display-name question set to `createAccountFake`. It rejects anything else.
   - Each rejection, and each request the fake itself refuses, appends one JSON line to the violations file. Each captured mail appends one JSON line to the mail file.
   - It replaces `WebSocket` with a constructor that throws, as `tests/integration/async-worker-preload.ts` does.
   - At startup it records a violation for any name that must stay empty and has a value in the server. The runner passes that list: the names from the env files that received no synthetic value.
7. **One place for what differs between stacks.** The user decided on 2026-11-26 that the suite has two modes: this faked mode on pull requests, and a real mode against deployed services that gates a release. The journeys are written once. Everything a journey needs from its stack lives in one module under `tests/e2e/`: the base URL, reading the sign-in mail for an address, the database pool, granting admin, and taking the recorded violations. Taking them means reading the violations file and truncating it. Journey files import only that module and the browser helper. This stage builds the faked implementation only and adds no switch or interface for the real one. The pool asserts a loopback host and the runner's database-name pattern before its first query, and it is ended when the tests finish.
8. **Tests** `tests/e2e/`. Playwright's library drives Chromium under `node --import tsx --test --test-concurrency=1`, because every journey shares one server, one violations file and one sign-in rate limit. A shared helper opens a context with tracing on and collects console errors, page errors and failed responses. A journey can declare a response it expects to fail, such as the 404 in E8, and the collector leaves that one out. On a failed test it writes a trace and a screenshot to `.artifacts/e2e/`. Each journey ends by taking the recorded violations and asserting there are none, except the fail-closed journey, which asserts the one it caused.
9. **Fixtures.** A fresh database per run. Admin access is granted with SQL on `ctf."user"."isAdmin"`, the documented manual grant. The run for the report journey is inserted with SQL: a game owned by a member used by no other journey, and its first session with `id` equal to the game id, ordinal 1, an `agent_model` from `MODELS`, status `ended`, no live lease and no reserved spend.
10. **Dependency.** `playwright` as a dev dependency. The Node test runner stays, as the repository policy asks.
11. **End-of-run checks in the runner.** After the tests, the run fails when the violations file still holds a line that no journey took, or when the server's output holds a line with event `route.failed` or an event ending in `_read_failed`.
12. **CI.** A second job `e2e` in `.github/workflows/ci.yml` with its own `timeout-minutes`: checkout, Node 24, `npm ci`, install Chromium with its system dependencies, pull `postgres:18-alpine`, `npm run test:e2e`, and upload `.artifacts/e2e/` with `if: failure()`. Actions are pinned by commit SHA like the existing ones. The existing `ci` job is unchanged.

## Tradeoffs considered

- **Preload against `instrumentation.ts`.** Next's own startup hook would put test code inside the application. The preload keeps the app untouched.
- **`fetch` replacement against `RESEND_BASE_URL` and a local mail server.** The SDK honours that variable, but OpenRouter has no such seam, so a second mechanism would still be needed. One `fetch` replacement covers both and reuses the existing validated fake.
- **Environment variables against a `ctfPool` preload for the database.** The pool seam works too. Plain `PG*` variables need no code in the server process and were proven in the spike.
- **One job against a step in `ci`.** A separate job runs in parallel and gives the ruleset a distinct check name. It costs a second `npm ci` and a second build.
- **Splitting part 2.** The run journeys need a Sprite fake, a scripted agent and a worker, which today exist only inline in an 11,000-line test file. Shipping 2a first puts a browser check on every pull request sooner and keeps each review readable.
- **Scanning `.next/` for file values after the build.** The verifier proposed it. Declined: the runner would have to read secret values, and the build's environment is asserted before the spawn with the same blanking that the server check proves.

## Acceptance criteria

| Id  | Given, when, then                                                                                                                                                                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| E1  | Given a checkout whose `.env*` files define real values, when the runner builds a child's environment, then every name from those files is empty or synthetic, the database variables point at loopback or at the unreachable build URL, and the server reports no blanked name with a value.                            |
| E2  | Given the running server, when server code calls `fetch` for a host other than loopback, Resend or the display-name endpoint, then the call rejects and one violation line names the URL. Given any violation line left after the tests, then the run fails.                                                             |
| E3  | Given a signed-out visitor, when they submit their email at `/signin` and open the link from the captured mail, then they are signed in. When the same link is opened in a fresh browser context, then `/api/auth/get-session` there returns no session.                                                                 |
| E4  | Given a new member with no display name, when they choose one, then the page shows it, it survives a reload, and `ctf."user"` stores it.                                                                                                                                                                                 |
| E5  | Given the pages `/`, `/rules`, `/rank`, `/contact` and `/signin` signed out, and `/play`, `/runs` and `/account` signed in, when each loads, then it shows its heading and produces no console error, no page error, no same-origin response with status 400 or higher, and no failed request other than an aborted one. |
| E6  | Given a signed-out visitor, when they send a message from `/contact`, then a feedback row exists and the message is listed on `/admin` for an admin.                                                                                                                                                                     |
| E7  | Given a member looking at their own run, when the Report button is visible and they send a report with it, then the stored report carries the run id and session id and is listed on `/admin`.                                                                                                                           |
| E8  | Given an admin, when they change one limit on `/admin` and reload, then the new value is shown and stored. Given a member who is not an admin, when they open `/admin`, then the response status is 404 and the page shows Next's not-found text.                                                                        |
| E9  | Given a failing browser test, when the run ends, then `.artifacts/e2e/` holds a trace and a screenshot for it.                                                                                                                                                                                                           |
| E10 | Given any outcome, success, test failure, startup failure or an interrupt, when the runner exits, then the container is removed, no server or Chromium process started by the run remains, and the exit code is non-zero unless every test passed.                                                                       |
| E11 | Given the workflow file, when `ci` runs on a pull request, then a job named `e2e` runs the suite and uploads artifacts on failure.                                                                                                                                                                                       |
| E12 | Given the extraction of the Postgres helper, when `npm run check`, the integration suite and one interrupted integration run execute, then the first two pass as before and the interrupted run removes its container.                                                                                                   |

## Criterion, check and evidence

| Id       | Check                                                                                                                                                                                                                                                                                                                                                                                               | Evidence                                                                                                                                                                                                                                                      |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1       | Offline test of the environment function with synthetic file listings, including `.env.production.local`. Offline test that the spawn guard rejects a non-empty `DATABASE_URL`. The preload's startup check runs in every suite run, and design item 11 fails the run on its violation.                                                                                                             | Passed. Seven offline tests in `tests/e2e-runner.test.ts`, each seen failing first. The server's startup check ran in every suite run and recorded nothing.                                                                                                   |
| E2       | Offline test of the factory: an unexpected host, the lookalike `127.0.0.1.evil.test` and a URL with userinfo each reject and record. One journey in the real server: an admin changes the agent model, which requests `https://openrouter.ai/api/v1/models`, and the test asserts exactly that violation line and the refusal the page shows. Design item 11 covers violations outside any journey. | Passed. Seven offline tests in `tests/e2e-preload.test.ts`, six seen failing first. The journey passes and fails when mutated to expect no violation.                                                                                                         |
| E3 to E8 | The journey tests in `tests/e2e/`, each written first and seen to fail for the intended reason.                                                                                                                                                                                                                                                                                                     | Passed. Nine journeys, 9 of 9 in the lead's runs on 2026-11-26, about 18 s wall clock. E3, E4, E6 and E7 failed first on the awaited text. E5 and E8 passed first and failed when mutated.                                                                    |
| E9       | Lead makes one assertion fail locally, runs the suite, lists the files, reverts.                                                                                                                                                                                                                                                                                                                    | Passed. With one assertion broken, the run exited 1 and left `e3-a-magic-link-signs-the-visitor-in-once-0.zip` and `.png` in `.artifacts/e2e/`.                                                                                                               |
| E10      | Lead runs: a passing run, a run with a failing test, a run with `PORT` set to a port already bound, and a run interrupted by SIGINT sent to the runner's pid alone. After each, `docker ps` shows no container with the runner's prefix and `pgrep` finds no `next start` and no Chromium from the run.                                                                                             | Passed. Failing test: exit 1. `PORT=39171` already bound: exit 1. SIGINT during the tests and during the build: exit 130. No container, `next` process or Chromium remained after any of them.                                                                |
| E11      | Workflow YAML parses and the job is inspected. The remote run stays unrun until the branch is pushed with the user's yes.                                                                                                                                                                                                                                                                           | YAML parses, jobs `ci` and `e2e`. `actions/upload-artifact` pinned at `cf430e03`, v7.0.2. The first remote run passed on 2026-11-26: run `45900710917` at `d05a915`, job `e2e` in 1 minute 36 seconds on Node 24 and Linux, job `ci` in 5 minutes 18 seconds. |
| E12      | `npm run check` and `npm run test:integration` before the extraction and after it, plus one integration run interrupted by SIGINT after the extraction.                                                                                                                                                                                                                                             | Passed. `npm run check` 604 of 604. `npm run test:integration` 648 of 648 in the lead's run. The developer's interrupted integration run exited 130 and left no container.                                                                                    |

Commands: `npm run check`, `npm run test:integration`, `npm run test:e2e`. Prerequisites: Docker running, image `postgres:18-alpine` present, Chromium installed with `npx playwright install chromium`. The integration suite also needs `ctf-flag-read-sprite:1`.

## Steps

1. Baseline: `npm run check` and `npm run test:integration` pass on the untouched worktree. Verify: both exit 0.
2. Extract the Postgres helper and switch the integration runner to it. Verify: E12.
3. Add `playwright`, the environment function and spawn guard with their offline tests, and the runner. Verify: the offline tests fail first, then pass. A run with no test files builds, migrates, starts and stops cleanly.
4. Add the preload factory with its offline test, then the installer. Verify: the offline test fails first, then passes. The startup log shows which thread installs.
5. Add the stack module, the browser helper and the journeys, one at a time, in the order E3, E4, E5, E6, E7, E8, then the fail-closed journey of E2. Verify: each fails for the intended reason before its helper or selector exists, then passes.
6. Add the `e2e` job and the documentation lines in `docs/verification.md` and `deploy/operations.md`. Verify: YAML parses, `npm run check` passes.
7. Lead verification of E9 and E10, then the full gates.

## Ownership

Owned paths: `package.json`, `package-lock.json`, `scripts/test-e2e.ts`, the new shared Postgres module under `scripts/`, `scripts/test-integration.ts`, `tests/e2e/`, the new offline tests under `tests/`, `.github/workflows/ci.yml`, `docs/verification.md`, `deploy/operations.md`, this plan.

Not owned: everything under `app/`, `lib/`, `db/` and `tests/integration/`. The fakes there are imported, not edited.

## Risks and open questions

- The spike showed the preload's top level running twice in one process. The developer's runs on Node 25 showed one evaluation, and the cause of the second was not confirmed. The once-per-thread marker makes a second evaluation harmless.
- `tsx` in `NODE_OPTIONS` hooks the server's module loading. It worked in the spike with a ready time of 153 ms. If it causes a failure the developer cannot explain, return to the lead.
- Sign-in is rate-limited per client address. The magic-link plugin allows five requests per minute to `/sign-in/magic-link` and five to `/magic-link/verify` for each address, and Better Auth takes the address from a single-value `x-forwarded-for` header. With no header under `next start`, every visitor shares one key, and the full suite hit the limit on 2026-11-26. Lead decision: each browser context sends its own address in that header. The stack module allocates it from a counter that is unique across the run, in 198.18.0.0/15, because a real deployment gets the address from its proxy and the journeys must not set it there. Production gets each visitor's address from the platform proxy, so this models it, and the limiter stays on and untouched.
- The report journey uses a run inserted with SQL. Stage 2c replaces it with a run started through the app.
- The fail-closed journey depends on the model catalogue being unfaked. Stage 2c fakes the catalogue and must give that journey another trigger.
- Every run rebuilds `.next` in the checkout and overwrites an earlier `npm run build` there.

## Plan verification

An independent read-only check on 2026-11-26 returned "approved with should-fix changes" and fifteen findings. All are folded in above except the `.next/` scan, declined under "Tradeoffs considered". A second pass accepted that decline, confirmed that the agent-model journey leaves no state behind and does not trip the server-output check, and returned five more findings, all folded in: truncating on take, serial test files, the empty-names list, the installation marker and the expected-failure allowance.

## Code review

An independent read-only review of the full change on 2026-11-26 found nothing at P0 or P1 and two P2 findings: the env file name parser was narrower than the dotenv that Next bundles, and test visitor addresses were unique per test file instead of per run. One corrective cycle fixed both and folded in six notes. The re-review approved with no P0 to P2 finding left.

Two P3 notes remain open. `takeViolations` can still lose a line that the server appends while the file is being renamed. The visitor counter is correct only while test files run one at a time, which the runner enforces.

Final state, from the lead's runs after the corrective cycle: `npm run check` 605 of 605, `npm run test:e2e` 9 of 9 in 18 s, `npm run test:integration` 648 of 648 before the cycle, which touched no file the integration suite runs. The remote `e2e` job then passed on pull request 50.

## Stage 2c constraints

Recorded from the survey so the next contract starts from them.

- The Sprite fake and the scripted agent exist only inline in `tests/integration/sprites.test.ts`. A preload for runs needs new code. `scripts/smoke-contract.ts` already maps instruction keywords to commands.
- Sprite `execFile` uses the global `WebSocket`, so the fake has to patch `Sprite.prototype` methods. `@fly/sprites` is a server external package, so the preload should reach the same module instance. Confirm that first.
- The app and the worker both touch a Sprite, so the fake's state must be shared between two processes.
- `SITE_URL` must be an https DNS name with no port, and `/v1/end` requires an https request URL and an exact `Host`. The fake upload must post to loopback with `x-forwarded-proto: https` and the `Host` header set. A non-empty `SITE_URL` also changes Better Auth's base URL handling and cookie names.
- The worker registers `http://127.0.0.1:<port>/wake` in the database with no extra setup, and the app's wake call accepts that address.
