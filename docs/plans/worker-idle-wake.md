# Monitor worker: no queries while idle

- Worktree: `/Users/jonathan/Code/ctf/.worktrees/worker-idle-wake`
- Branch: `feature/worker-idle-wake`, from `main` at `9657348`
- Status: contract, not built

## Problem

The monitor worker keeps its Neon database awake all day.

- `scripts/monitor-worker.ts` runs 4 loops. Each calls `runMonitorWorkerOnce()` and sleeps 1 second when there was no work. An idle pass runs `markExpiredFinalizationClaims`, `claimAsyncFinalization` and `claimMonitorJob`.
- Neon suspends a compute after 5 minutes without a query. The worker never leaves 5 minutes.
- Production's compute `ep-super-queen-arhsf7a9` has been active since 2026-11-14 01:04 UTC. Its minimum size is 0.25 CU, which is 6 CU-hours a day. Each pull request preview has its own Neon branch and its own worker, so one open preview doubles that. The plan allows 100 CU-hours a month.
- A slower poll does not fix it. Each query keeps the compute up for 5 more minutes, so a poll every 30 minutes still costs a sixth of always-on and delays every review by up to 30 minutes.
- `LISTEN` does not fix it. Neon's documentation says an idle connection does not count as activity, so the compute suspends and drops the listener.

## Decisions by the user

- 2026-11-21: the worker must stop keeping the databases awake.

Open, with the lead's default: this ships as its own pull request from `main`, ahead of pull request 37.

## Goal

A worker with nothing to do runs no query. The app tells it when work exists. A review still starts within a second or two of the work being queued.

## Design

### Wake endpoint

- The worker process serves HTTP. `POST /wake` with `Authorization: Bearer <token>` answers 204 and wakes the loops. A wrong or missing token answers 401. Every other path or method answers 404. The request body is not read.
- The token is 32 random bytes, made at process start, compared in constant time.
- The port is `PORT` when set and an ephemeral port otherwise. The `Dockerfile` sets `PORT=8080`. The server listens on all interfaces when `FLY_APP_NAME` is set and on loopback otherwise.
- `--once` starts no server and registers nothing.

### Registration

- At start, after the server is listening, the worker upserts one row in `ctf.settings` with key `worker_wake`. Its value is JSON: `{ "url": string, "instance": string | null, "token": string }`.
  - On Fly: `url` is `https://<FLY_APP_NAME>.fly.dev/wake` and `instance` is `FLY_MACHINE_ID`.
  - Elsewhere: `url` is `http://127.0.0.1:<port>/wake` and `instance` is null.
- The database is the one place the app and its worker already share, in production, in each preview and in local development. No new secret or environment variable is needed, and each preview finds its own worker.
- The row must never leave the server. No API response, admin page or log line includes the token. The developer checks every reader of `ctf.settings`.

### The app's wake call

- `wakeWorker(client)` in a new `lib/worker-wake.ts` reads the row with the caller's client and sends the `POST` with a 2 second timeout. When `instance` is set it adds the header `fly-force-instance-id: <instance>`.
- It is called from `enqueueMonitorJob` and from each place that inserts a `ctf.finalization_jobs` row.
- It never fails or delays the caller. A missing row sends nothing. A malformed row, a refused connection, a timeout or a non-204 answer is logged as `worker.wake.failed` with no token in the line. The request is not awaited inside the transaction.
- Inside a request the call is handed to Next's `after()` so it survives the response ending. Read `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/after.md` first. Outside a request it is an unawaited call whose rejection is handled.
- `url` must be `https:`, or `http:` to `127.0.0.1`. Anything else is treated as malformed.
- The call is made before the caller's transaction commits. The worker's 30 second linger below covers that gap.

### The loop

The loop moves from `scripts/monitor-worker.ts` into a new `lib/monitor-worker-loop.ts` whose dependencies are passed in: the pass function, the pending check, the clock and the wake gate. The script wires the real ones.

- **Pending.** One query, `hasPendingWork()`: a `ctf.monitor_jobs` row with status `queued` or `reviewing`, or a `ctf.finalization_jobs` row with status `queued` or `scoring`.
- **Awake.** A loop polls as today, one pass and then 1 second of sleep when the pass did nothing, while any of these holds:
  - a wake arrived, or the process started, less than 30 seconds ago;
  - work is pending and the last progress was less than 45 minutes ago. Progress is a pass that did work, a wake, or the process start.
- **Dormant.** Otherwise the loops wait and run no query. They resume on a wake, and once every 6 hours as a safety net for a wake that was lost.
- A wake that arrives while the pending check is in flight is not lost: the loop checks for it after the query returns and before it waits.
- The 4 loops share one gate. `SIGTERM` and `SIGINT` end a dormant loop at once.
- The four durations are named constants in the loop module.

Why 45 minutes: pending rows normally clear by themselves through a claim expiring after 90 seconds, a session lease expiring after 270 seconds, or a retry. On `main` a run can sit in `finalizing` forever behind an unresolved review, and its finalization job stays `queued`. Without a limit that one run would keep the worker polling. Pull request 37 retries such a review after at most 40 minutes, so 45 covers its longest gap.

### Fly

- `fly.toml` gains an `[http_service]` with `internal_port = 8080`, `force_https = true`, `auto_stop_machines = "off"`, `auto_start_machines = false`, `min_machines_running = 1`.
- `.github/workflows/preview-worker.yml` adds `--port 443:8080/tcp:http:tls` to `flyctl machine run`.
- Neither Fly app has a public address today (`flyctl ips list`, 2026-11-21). The user allocates them once per app before merge: `fly ips allocate-v4 --shared -a <app>` and `fly ips allocate-v6 -a <app>` for `ctf-monitor-worker` and `ctf-monitor-worker-preview`. `README.md` or `deploy/` records the step.
- The machine keeps running. Stopping it when idle is out of scope.

## Deploy order

- New app with an old worker: the app finds no row and sends nothing. The old worker polls as before. Safe.
- Old app with a new worker: nothing wakes the worker, and reviews wait for the 6 hour check. On a normal merge Vercel deploys the app minutes before the workflow deploys the worker. Rolling the app back past this change requires rolling the worker back too. `README.md` says so.
- A deploy starts a new machine, which registers itself and drains the queue at start.

## Out of scope

- Stopping or suspending the Fly machine when idle.
- The play page's own 3 second poll, which runs only while a tab is visible.
- The daily cleanup cron.
- Changing how reviews are claimed, retried or finalized.

## Acceptance

Integration tests use real Postgres and the real worker code. The investigator and classifier keep their existing provider fakes.

- W1. Unit, on the loop module with an injected clock: it polls while work is pending; it goes dormant 30 seconds after start when nothing is pending; a wake during the pending check causes another pass; with work pending and no progress it goes dormant at 45 minutes; a dormant loop runs a pass at 6 hours; a stop signal ends a dormant loop.
- W2. Integration: `hasPendingWork()` is true for a `queued` and a `reviewing` monitor job and for a `queued` and a `scoring` finalization job. It is false for an empty database and for one holding only `caught-up`, `unresolved`, `caught` and `done` rows.
- W3. Integration: the wake server answers 204 to the right token, 401 to a wrong or missing one and 404 to another path or method. Starting the worker writes the `worker_wake` row. Starting it again replaces the row, and the old token is then refused.
- W4. Integration, through the real application paths: a saved agent message, a completed command and a submission each send one authenticated `POST` to a registered local server. With no row nothing is sent and the write commits. With a row that points at a closed port, and with one that is malformed, the write still commits and one `worker.wake.failed` line is logged without the token.
- W5. Integration, end to end with the real loop in process: after its linger the loop is dormant and the pool hands out no connection for 3 seconds, counted on the real pool's `acquire` event. A message saved through the application path is then reviewed without the test calling `runMonitorWorkerOnce`. The loop goes dormant again afterwards.
- W6. No admin or API response contains the `worker_wake` value. A test reads the admin rules and model endpoints with the row present.
- W7. `fly.toml`, the preview workflow and the `Dockerfile` name the same port.
- G1. `npm run check`, `npm run test:integration`, `npm run build` and `npm run test:coverage` pass.

## Live check by the lead, after the preview deploys

- E1. With nobody playing, the preview's Neon compute reports `idle` within 10 minutes of the worker starting.
- E2. One played message on the preview is reviewed, and the time from the message being saved to the review starting is recorded.
- E3. The compute reports `idle` again within 10 minutes of the last request.

## Risks

- A lost wake delays a review by up to 6 hours. A wake is lost when the POST fails and no later one follows. The start-up drain covers deploys and crashes.
- The worker gets a public address. Only `POST /wake` with the token does anything, and all it does is start a poll.
- A run stuck in `finalizing` on `main` keeps the worker polling for 45 minutes after every wake. Production has one such run, `33b097dd`. Pull request 37 resolves such runs.
- A compute that was suspended takes a moment to resume, so the first review after a quiet period starts later than today.
- During a deploy the registered row can point at a machine that is stopping. The new machine replaces the row at start.

## Follow-up in pull request 37

Merge `main` into `feature/screen-actions` after this lands. Its retry timers need no change: a run in `finalizing` has a `queued` finalization job, which counts as pending, and its longest gap between attempts is 40 minutes.

## Evidence

- Loop and enqueue sites read by the lead at `9657348`: `scripts/monitor-worker.ts`, `lib/monitor-worker.ts`, `enqueueMonitorJob` callers in `lib/monitor-commands.ts`, `lib/sessions.ts` and `lib/games.ts`, finalization inserts in `lib/flag-submissions.ts` and `lib/async-finalization.ts`.
- Neon, 2026-11-21: `list_branch_computes` on the production branch shows `started_at` 2026-11-14T01:04:11Z, `current_state` active, minimum 0.25 CU, suspend timeout at the plan default.
- Neon documentation, "WebSockets and SSE on Neon Functions": "an idle connection doesn't count as active traffic. Scale to zero suspends the compute on its normal timer and drops that connection".
- Fly documentation: the `fly-force-instance-id` request header forces routing to one Machine with no fallback. A Machine made with `fly machine run` declares a service with `--port 443:<internal>/tcp:http:tls`, and the app needs addresses from `fly ips allocate-v6` and `fly ips allocate-v4 --shared`. Every Machine has `FLY_MACHINE_ID` and `FLY_APP_NAME`.
- Fly, 2026-11-21: `flyctl ips list` shows no address on either app.
