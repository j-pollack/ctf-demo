# Monitor worker: no queries while idle

- Worktree: `/Users/jonathan/Code/ctf/.worktrees/worker-idle-wake`
- Branch: `feature/worker-idle-wake`, stacked on `feature/investigator-context` at `9efc118`, the head of pull request 37
- Status: contract verified with changes folded in, not built

## Problem

The monitor worker keeps its Neon database awake all day.

- `scripts/monitor-worker.ts` runs 4 loops. Each calls `runMonitorWorkerOnce()` and sleeps 1 second when there was no work. An idle pass runs `markExpiredFinalizationClaims`, `requeueUnresolvedMonitorJobs`, `resolveUnverifiedRuns`, `claimAsyncFinalization` and `claimMonitorJob`.
- Neon suspends a compute after 5 minutes without a query. The worker never leaves 5 minutes.
- Production's compute `ep-super-queen-arhsf7a9` has been active since 2026-11-14 01:04 UTC. Its minimum size is 0.25 CU, which is 6 CU-hours a day. Each pull request preview has its own Neon branch and its own worker, so one open preview doubles that. The plan allows 100 CU-hours a month.
- A slower poll does not fix it. Each query keeps the compute up for 5 more minutes, so a poll every 30 minutes still costs a sixth of always-on and delays every review by up to 30 minutes.
- `LISTEN` does not fix it. Neon's documentation says an idle connection does not count as activity, so the compute suspends and drops the listener.

## Decisions by the user

- 2026-11-21: the worker must stop keeping the databases awake.
- 2026-11-21: the design and its cost are accepted, and the lead may proceed. Fly addresses are free when the IPv4 one is shared.

- 2026-11-21: this ships in pull request 37, not as its own pull request. Production gets it when that pull request merges.

## Goal

A worker with nothing to do runs no query. The app tells it when work exists. A review still starts within a second or two of the work being queued.

## Design

### Wake endpoint

- The worker process serves HTTP. `POST /wake` with `Authorization: Bearer <token>` answers 204 and wakes the loops. A wrong or missing token answers 401. Every other path or method answers 404. The request body is not read.
- The token is 32 random bytes, made at process start, compared in constant time.
- The server listens on port 8080 on all interfaces when `FLY_APP_NAME` is set, and on an ephemeral loopback port otherwise. It does not read `PORT`: `scripts/dev.ts` passes the Next server's `PORT` to the worker too.
- `--once` starts no server and registers nothing.

### Registration

- At start, after the server is listening, the worker upserts one row in `ctf.settings` with key `worker_wake`. Its value is JSON: `{ "url": string, "instance": string | null, "token": string }`.
  - On Fly: `url` is `https://<FLY_APP_NAME>.fly.dev/wake` and `instance` is `FLY_MACHINE_ID`.
  - Elsewhere: `url` is `http://127.0.0.1:<port>/wake` and `instance` is null.
- On a clean exit the worker deletes the row if its value is still its own.
- The database is the one place the app and its worker already share, in production, in each preview and in local development. No new secret or environment variable is needed, and each preview finds its own worker.
- The row must never leave the server. No API response, admin page or log line includes the token. Every reader of `ctf.settings` filters by key today.

### The app's wake call

- `wakeWorker()` in a new `lib/worker-wake.ts` reads the row through the pool, not through the caller's transaction, and sends the `POST` with a 2 second timeout. When `instance` is set it adds the header `fly-force-instance-id: <instance>`.
- The caller does not await it. It never throws into the caller and never touches the caller's transaction. A missing row or a missing `ctf.settings` table sends nothing. A malformed row, a refused connection, a timeout or a non-204 answer is logged as `worker.wake.failed` with no token in the line.
- It is called from `enqueueMonitorJob`, from `beginAsyncSubmission` where it inserts the finalization job, from `promoteHttpSubmission` only when it promotes, and at the end of the cleanup route `app/api/cleanup/route.ts`.
- It is a plain unawaited `fetch`. Next's `after()` is not used: it throws outside a request, its callback form runs only when a response closes, and every call site is inside a request that outlives the 2 second call.
- `url` must be `https:`, or `http:` to `127.0.0.1`. Anything else is treated as malformed.
- The call can leave before the caller's transaction commits. The worker's 30 second linger below covers that gap. A rolled-back transaction costs one empty poll.
- `lib/worker-wake.ts` imports nothing from `next`.

### The loop

The loop moves from `scripts/monitor-worker.ts` into a new `lib/monitor-worker-loop.ts` whose dependencies are passed in: the pass function, the pending check, the clock, the durations and the wake gate. The script wires the real ones.

- **Pending.** One query, `hasPendingWork()`:
  - a `ctf.monitor_jobs` row with status `queued` or `reviewing`, or
  - a `ctf.finalization_jobs` row with status `scoring`, or
  - a `ctf.finalization_jobs` row with status `queued` whose run is `finalizing` with no `finalization_error`.

  A run caught after it submitted keeps a `queued` finalization job forever. Production has 12 such rows. They are not pending.

- **Awake.** A loop polls as today, one pass and then 1 second of sleep when the pass did nothing, while any of these holds:
  - the process started less than 10 minutes ago;
  - a wake arrived less than 30 seconds ago;
  - work is pending and the last progress was less than 45 minutes ago. Progress is a pass that did work, a wake, or the process start.
- **Dormant.** Otherwise the loops wait and run no query. They resume on a wake, and once every 6 hours as a safety net for a wake that was lost.
- A wake that arrives while the pending check is in flight is not lost: the loop checks for it after the query returns and before it waits.
- The 4 loops share one gate. `SIGTERM` and `SIGINT` end a dormant loop at once.
- When the loops have settled, for a signal or a failure, the script closes the server and clears its timers before it ends the pool, so the process exits with the code it has today. A worker whose loops have died must not keep answering 204.
- The five durations are named constants in the loop module.

Why 10 minutes after start: production's alias switches to the new app only after the new worker has deployed, so for a few minutes the old app, which sends no wake, is still queueing work. A turn on it lasts at most 300 seconds.

Why 45 minutes: pending rows normally clear by themselves through a review claim expiring after 120 seconds, a session lease expiring after 270 seconds, or a retry. A failed review of a submitted run is retried after at most 40 minutes, so 45 covers the longest gap between attempts. The limit also bounds a run held in `finalizing` by a hold on its money or by an open Sprite operation.

### Fly

- `fly.toml` gains an `[http_service]` with `internal_port = 8080`, `force_https = true`, `auto_stop_machines = "off"`, `auto_start_machines = false`, `min_machines_running = 1`.
- `.github/workflows/preview-worker.yml` adds `--port 443:8080/tcp:http:tls` to `flyctl machine run`.
- Neither Fly app has a public address today (`flyctl ips list`, 2026-11-21). Before merge each app gets `fly ips allocate-v4 --shared -a <app>` and `fly ips allocate-v6 -a <app>`, for `ctf-monitor-worker` and `ctf-monitor-worker-preview`. A dedicated IPv4 address is billed and is not needed. `README.md` records the step.
- The machine keeps running. Stopping it when idle is out of scope.

## Deploy order

- The new worker goes live before the new app, because the production alias waits for the `deploy worker` check. The 10 minute window after start covers work queued by the old app.
- New app with an old worker: the app finds no row and sends nothing. The old worker polls as before.
- Rolling the app back past this change requires rolling the worker back too. Otherwise nothing wakes the worker and reviews wait for the 6 hour pass. `README.md` says so.

## Out of scope

- Stopping or suspending the Fly machine when idle.
- The play page's own 3 second poll, which runs only while a tab is visible.
- Changing how reviews are claimed, retried or finalized.

## Acceptance

Integration tests use real Postgres and the real worker code. The investigator and classifier keep their existing provider fakes. Tests pass short durations to the loop and do not wait in real time.

- W1. Unit, on the loop module with an injected clock: it polls while work is pending; with nothing pending it stays awake for the start window and then goes dormant; a wake keeps it awake for the linger; a wake during the pending check causes another pass; with work pending and no progress it goes dormant at the limit; a dormant loop runs a pass at the safety interval; a stop signal ends a dormant loop.
- W2. Integration: `hasPendingWork()` is true for a `queued` and a `reviewing` monitor job, for a `scoring` finalization job, and for a `queued` finalization job on a `finalizing` run. It is false for an empty database, for one holding only `caught-up`, `unresolved`, `caught` and `done` rows, for a `queued` finalization job on a `caught` run, and for one on a `finalizing` run with a `finalization_error`.
- W3. Integration: the wake server answers 204 to the right token, 401 to a wrong or missing one and 404 to another path or method. Starting the worker writes the `worker_wake` row. After a second worker starts, `wakeWorker()` reaches the second server with the second token. A clean exit removes the worker's own row and leaves another worker's row alone.
- W4. Integration, through the real application paths: a saved agent message, a completed command and an HTTP submission each send at least one authenticated `POST` to a registered local server. A completed command that promotes nothing sends none for the promotion. With no row, and with no `ctf.settings` table, nothing is sent and the write commits. With a row that points at a closed port, and with one that is malformed, the write still commits and a `worker.wake.failed` line is logged without the token.
- W5. Integration, end to end with the real loop in process: once dormant, the pool hands out no connection for 3 seconds, counted on the real pool's `acquire` event. A message saved through the application path is then reviewed without the test calling `runMonitorWorkerOnce`. The loop goes dormant again afterwards.
- W6. No admin or API response contains the `worker_wake` value. A test reads the admin rules and model endpoints with the row present.
- W7. The worker script, started as a child process, exits with code 0 within a few seconds of `SIGTERM` while dormant, and exits non-zero when a pass throws.
- G1. `npm run check`, `npm run test:integration`, `npm run build` and `npm run test:coverage` pass.

## Live check by the lead, after the preview deploys

The preview's database is a copy of production and holds the stuck run `33b097dd`. This branch's worker requeues and resolves it at start.

- E1. With nobody playing, the preview's Neon compute reports `idle` within 20 minutes of the worker starting. Run `33b097dd` has left `finalizing` on the preview.
- E2. One played message on the preview is reviewed, and the time from the message being saved to the review starting is recorded.
- E3. The compute reports `idle` again within 10 minutes of the last request.

## Risks

- A lost wake delays a review by up to 6 hours. A wake is lost when the POST fails and no later one follows. The start-up window covers deploys and crashes.
- The worker gets a public address. Only `POST /wake` with the token does anything, and all it does is start a poll.
- A run whose scoring failed is ended after 24 hours by `resolveUnverifiedRuns`. Its finalization job is `unresolved`, which is not pending, so that now happens on the first wake or 6 hour pass after the 24 hours.
- A hold on a run's money that the cleanup job or a page load settles more than 45 minutes after the run submitted can unblock scoring while the worker is dormant. The cleanup route's wake covers the daily job. The page load case waits for the next wake or the 6 hour pass.
- A compute that was suspended takes a moment to resume, so the first review after a quiet period starts later than today.
- A preview's database starts as a copy of production's, so until the preview's worker registers, play on the preview wakes production's worker. That costs production one empty poll.
- Several worktrees can share one development database. The last worker to start owns the row.

## Step 3

The routing step must keep `hasPendingWork()` true for any job state it adds that the worker has to act on without a new enqueue.

## Evidence

- Loop and enqueue sites read by the lead at `9657348`: `scripts/monitor-worker.ts`, `lib/monitor-worker.ts`, `enqueueMonitorJob` callers in `lib/monitor-commands.ts`, `lib/sessions.ts` and `lib/games.ts`, finalization inserts in `lib/flag-submissions.ts` and `lib/async-finalization.ts`.
- Neon, 2026-11-21: `list_branch_computes` on the production branch shows `started_at` 2026-11-14T01:04:11Z, `current_state` active, minimum 0.25 CU, suspend timeout at the plan default.
- Neon documentation, "WebSockets and SSE on Neon Functions": "an idle connection doesn't count as active traffic. Scale to zero suspends the compute on its normal timer and drops that connection".
- Fly documentation: the `fly-force-instance-id` request header forces routing to one Machine with no fallback. A Machine made with `fly machine run` declares a service with `--port 443:<internal>/tcp:http:tls`, and the app needs addresses from `fly ips allocate-v6` and `fly ips allocate-v4 --shared`. Every Machine has `FLY_MACHINE_ID` and `FLY_APP_NAME`. Fly's pricing page lists shared IPv4 and IPv6 addresses at no charge and inbound data as free.
- Fly, 2026-11-21: `flyctl ips list` shows no address on either app.
- Plan verification, 2026-11-21. Verdict: not ready, four blocking findings, all folded in.
  - A run caught after submitting keeps a `queued` finalization job, so pending stayed true forever. The lead confirmed 12 such rows on production. Pending now requires the run to be `finalizing` with no error.
  - `scripts/dev.ts` passes Next's `PORT` to the worker. The worker now ignores `PORT`.
  - A listening server kept a dead worker's process alive. The script now closes it when the loops settle, and W7 checks the exit.
  - `after()` throws outside a request and its callback form waits for the response to close. It is dropped for a plain unawaited `fetch`.
  - Also folded in: the row is read through the pool so a failure cannot abort the caller's transaction; the worker deploys before the app, so it stays awake 10 minutes after start; the cleanup route sends a wake; a worker removes its own row on exit; the review claim lasts 120 seconds; W3, W4 and W5 were sharpened.
- 2026-11-21: the user moved this into pull request 37. The branch was rebased from `main` onto `9efc118` before any code was written. On that base the idle pass also requeues unresolved reviews and resolves unverified runs, both of which a `queued` finalization job on a `finalizing` run keeps pending.
- Build, 2026-11-21. The lead ran the gates on the final tree: check 396 passed, integration 379 passed, build passed, coverage 396 passed.
- Code review, 2026-11-21. Verdict: approve with fixes, no blocking finding. Applied: the cleanup route awaits its wake, because nothing keeps that function alive after it answers; the wake request does not follow redirects; a non-204 response body is released; a wake after stop does nothing; a failed registration logs one line with the error's name and exits non-zero; a test that a wake counts as progress. Left as built: W6 reads the settings through the library readers the admin routes call, and W7 does not itself prove the child was dormant at the signal, which W5 proves in process.
- Not exercised by any test: the Fly path, where `FLY_APP_NAME` selects port 8080 and the `https` address. E1 to E3 on the preview cover it.
- Live check on pull request 37's preview, 2026-11-21, worker image `13b9122` started at 01:38:40 UTC.
  - The worker registered `https://ctf-monitor-worker-preview.fly.dev/wake` with its machine id. Through Fly, `POST /wake` with no token answered 401 and `GET /` answered 404.
  - E2. The user played run `0496a49a` on the preview. The worker's start window ended at 01:48:40 with nothing pending. A turn's last message was saved at 01:50:12.4 and its review started at 01:50:14.4.
  - E1 and E3. The preview's compute `ep-dry-sun-ard3ik8f` had been active since 2026-11-20 03:23 UTC. Neon suspended it at 02:14:47, five minutes after the last query, which was the lead's own diagnostic at 02:09:36. At two earlier checks the only database connections were the app's, serving the user's session.
  - Run `33b097dd` is `caught` on the preview.
