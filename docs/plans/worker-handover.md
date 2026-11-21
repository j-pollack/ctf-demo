# Worker handover: a deploy does not cost a review

- Worktree: `/Users/jonathan/Code/ctf/.worktrees/worker-handover`
- Branch: `feature/worker-handover`, stacked on `feature/investigator-completion`
- Status: contract, not verified, not built
- Ships in pull request 37.

## Problem

A deploy stops the worker, and a review still running when it stops is lost.

- A review can run for ten minutes after `docs/plans/investigator-completion.md`. Its conversation lives in the worker's memory.
- Production deploys with `flyctl deploy`, which replaces the one machine in place. Fly signals the process and stops it after `kill_timeout`, which Fly caps at 300 seconds and calls best-effort.
- Previews deploy with `flyctl machine destroy --force` on the branch's old machine and then `flyctl machine run` for the new one. The old machine gets no time.
- A review cut off this way is repeated from the start after its claim expires, 11 minutes later, and the attempt counts against the job's three.

The worker already finishes its current reviews when it is asked to stop. Only the forced stop cuts them short.

## Decisions by the user

- 2026-11-21: losing a review that has run for five minutes is a huge loss. The worker stays on a review until the investigator is done.

## Goal

On a deploy the new worker starts beside the old one. The old one takes no new work, finishes what it has and then exits. No review is interrupted by a deploy.

## Design

### Drain endpoint

- The worker's HTTP server gains `POST /drain`, with the same bearer token as `/wake`. It answers 204 and stops the loops the way `SIGTERM` does: no new pass starts, and passes in flight run to their end.
- When the loops have settled the worker closes its server, removes its own registration row if it still holds it, ends its pool and exits 0, as it does today after a signal.
- `/drain` on a worker that is already stopping answers 204 and changes nothing.

### The new worker drains the old one

- At start, before it writes its own registration, the worker reads the existing `worker_wake` row.
- After its own registration is written, it sends `POST /drain` to the old worker when all of these hold:
  - it runs on Fly, that is `FLY_APP_NAME` is set;
  - the old row parses, and its URL's host is this app's own host, `<FLY_APP_NAME>.fly.dev`;
  - the old row's `instance` is set and is not this machine's `FLY_MACHINE_ID`.
- The request goes to the old row's URL with `/wake` replaced by `/drain`, the old row's token and the header `fly-force-instance-id: <old instance>`. It has a 5 second timeout.
- A failure is logged as `worker.drain.failed` with a reason code and no token. The new worker carries on. The old machine is then gone already, or it runs code from before this change.
- The host check matters. A preview's database starts as a copy of production's and holds production's row. Without the check, a new preview's worker would drain production's.
- Local development does not drain. Worktrees share one development database, and one worktree's worker must not stop another's.

### Machines

Both deploys become: build the image, start a new machine, leave the old one to drain.

- Every worker machine is started with `--restart on-failure`, `--rm`, `--port 443:8080/tcp:http:tls` and `--metadata handover=1`. `--rm` removes a machine when its process exits cleanly, which is how a drained worker's machine goes away.
- **Previews**, `.github/workflows/preview-worker.yml`: the deploy job starts the new machine first. It then force-destroys only the branch's machines that lack `handover=1`, which are machines from before this change. It no longer destroys the branch's other machines. The destroy job for a deleted branch is unchanged.
- **Production**, `.github/workflows/migrate-prod.yml`: the deploy job builds and pushes with `flyctl deploy --build-only --push`, as previews do, and starts a machine with `flyctl machine run` in `ctf-monitor-worker`. It then force-destroys the app's machines that lack `handover=1`. That happens once: the machine `flyctl deploy` made runs the old code, has no `/drain`, and restarts itself whenever it exits.
- `fly.toml` keeps its `[build]` section for the image build. Its `[http_service]`, `[[restart]]` and `[[vm]]` sections no longer describe a running machine and are removed, with a comment that names the workflow as the place machines are configured. `kill_timeout` is set per machine with `--kill-timeout 300` if `flyctl machine run` accepts it, and otherwise left at Fly's default.
- Production's secrets are app secrets on `ctf-monitor-worker` and reach every machine in the app.

### Starting without Fly's restart loop

Production's machine restarts on any exit today. Under `on-failure` Fly retries a failing machine 10 times in 5 minutes and then leaves it stopped. A database outage longer than that would leave production with no worker.

- At start the worker retries its registration with a backoff that grows to 30 seconds, for as long as it takes, and logs each failure as `monitor.worker.start.retry`. It exits non-zero only for an error that is not a connection or availability error.
- A pass that throws still stops the loops and exits non-zero, as today. Fly restarts the machine, and the new process then waits in the registration retry until the database answers.

## Deploy order and overlap

- Two workers run at once for as long as the old one's reviews take, at most about eleven minutes. Claims are exclusive, so no job is reviewed twice.
- The registration row points at the new worker from the moment it starts. Wake calls go to it.
- Several deploys in a row leave several workers draining. Each exits when its own reviews end.
- The new worker's code may be newer than a review the old one is finishing. Each review is finished by the code that started it.

## Out of scope

- A crash of the worker or its host. A review in flight is lost then. Saving a review's conversation so another worker can resume it is a separate change.
- Stopping an idle machine to save its cost.
- More than one active worker per database.

## Acceptance

Integration tests use real Postgres and the real worker code, with provider fakes only.

- H1. `POST /drain` with the right token answers 204. A wrong or missing token answers 401. The worker then starts no new pass, a pass in flight runs to its end with its verdict stored, and the process exits 0.
- H2. A worker that starts with another worker's row present, with the Fly environment set for the same app, sends one authenticated `POST /drain` to the old address with the old token and the old instance header. The test serves the old address locally through the existing fetch seam.
- H3. No drain is sent when `FLY_APP_NAME` is not set, when the old row's host is another app's, when the old row is malformed, and when the old row's instance is this machine's.
- H4. A failed drain call logs `worker.drain.failed` without the token and the worker runs normally.
- H5. Registration is retried: with the settings table unavailable at start and then restored, the worker logs `monitor.worker.start.retry`, registers and runs. It has not exited.
- H6. End to end in process: an old worker is in a review that a fake provider holds open. A new worker starts and drains it. The new worker claims a second job while the first review is still held. When the fake releases, the old worker stores its verdict and exits 0. The first job has one review row and one attempt.
- G1. `npm run check`, `npm run test:integration`, `npm run build` and `npm run test:coverage` pass.

## Live check by the lead

- E1. On the preview: with a review in flight, push a commit. The old machine finishes the review, the review has one row, and the machine is gone afterwards. The new machine is running and registered.
- E2. On the preview: a machine from before this change is destroyed by the deploy job.
- E3. Production cannot be checked before merge. The first production deploy is watched by the lead with the user: one new machine running and registered, the old machine destroyed, a review completing.

## Risks

- Production's deploy mechanics change, and the change cannot be rehearsed on production. The preview uses the same commands in a different app.
- If the new worker fails before it drains the old one, both keep working. Nothing is lost and the next deploy drains them.
- A drained machine that never exits, because a review hangs past every limit, stays until a later deploy. Its review deadline bounds this at ten minutes.
- `--rm` with `--restart on-failure` is used as Fly documents each flag. Their combination is not documented and E1 is the first proof.
- The first production deploy force-destroys the old machine, so a review in flight at that moment is lost, once.

## Evidence

- Deploy steps read by the lead at `f067863`: `.github/workflows/preview-worker.yml`, the `deploy worker` job in `.github/workflows/migrate-prod.yml`, `fly.toml`, `scripts/monitor-worker.ts`, `lib/monitor-wake-server.ts`.
- Fly documentation: `kill_timeout` "up to a maximum of 300 seconds (5 minutes)" and best-effort. `fly machine run --rm`: "Automatically remove the Machine when it exits. Sets the restart-policy to 'never' if not otherwise specified." Restart policy `on-failure`: "Try up to `max_retries` (default 10) times within a 5-minute window". `always`: "never let it enter a `stopped` state, even when the main process exits cleanly". `fly machine kill` sends SIGKILL only, and no command sends another signal without a stop deadline.
