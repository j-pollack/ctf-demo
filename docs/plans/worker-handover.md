# Worker drain: a deploy does not cost a review

- Worktree: `/Users/jonathan/Code/ctf/.worktrees/worker-handover`
- Branch: `feature/worker-handover`, stacked on `feature/investigator-completion`
- Status: contract, second draft after plan verification, not built
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

## Decisions by the lead, open to the user

- The deploy waits for the old worker. The first draft started a new worker beside the old one and had the new one drain the old. The plan verifier found five blocking problems in it, among them an older worker draining a newer one and production left with no machine, and proposed this simpler design. It keeps production's deploy command, restart policy and rollback as they are.
- The cost is that no new review starts while the old worker finishes, at most about eleven minutes, and the deploy takes that much longer. Queued work is reviewed when the new worker starts.

## Goal

Before a deploy replaces the worker, the worker is told to drain. It takes no new work and finishes what it has. The deploy replaces it only when it is done.

## Design

### Drain endpoint

- The worker's HTTP server gains `POST /drain`, with the same bearer token as `/wake`. It answers 204 and stops the loops the way a signal does: no new pass starts, and passes in flight run to their end.
- When the loops have settled after a drain, the worker closes its server, removes its own registration row and ends its pool. It does not exit. It waits for a stop signal, and on `SIGTERM` or `SIGINT` it exits 0 at once.
- It does not exit because production's machine restarts on every exit, and a restart would put it back to work in the middle of a deploy.
- If no signal arrives within 15 minutes of the drain completing, the worker exits with code 1. Both restart policies then restart it and it works again. A deploy that failed after the drain, or a drain sent by mistake, therefore pauses reviews for at most 15 minutes.
- A worker stopped by a signal without a drain behaves as today, and exits 0 whatever its passes returned.
- `/drain` on a worker that is already draining answers 204 and changes nothing.

### Drain script

`scripts/drain-worker.ts`, run by the deploy jobs with the database URL and the Fly app name.

1. It reads the `worker_wake` row. No row: it prints that there is nothing to drain and exits 0.
2. The row must parse, and its URL's host must be `<app>.fly.dev` for the app name it was given. Otherwise it prints why and exits 0 without sending anything. A preview's database starts as a copy of production's and can still hold production's row. This check is what keeps a preview's deploy from draining production.
3. It sends `POST /drain` to the row's URL with the path set to `/drain`, the row's token and the `fly-force-instance-id` header, with a 10 second timeout and no redirects.
   - 204: it polls the row every 2 seconds until the row is gone or its value has changed, for at most 12 minutes, then exits 0. If the 12 minutes pass it prints a warning and exits 0, and the deploy goes on.
   - 404: the worker runs code from before this change. It exits 0.
   - A refused connection, a timeout or any other status: it prints the reason code and exits 0. The worker is not reachable, so there is nothing to wait for.
4. It never prints the token or the database URL.

### Workflows

- **Production**, the `deploy worker` job in `.github/workflows/migrate-prod.yml`. The steps become:
  1. build and push the image: `flyctl deploy --build-only --push --remote-only --image-label "$HEAD_SHA"`;
  2. install dependencies and run the drain script with `DATABASE_URL_UNPOOLED` from the repository secret the migrate job already uses, and the app name `ctf-monitor-worker`;
  3. release the built image: `flyctl deploy --ha=false --image "registry.fly.io/ctf-monitor-worker:$HEAD_SHA"`.

  Building first keeps the time with no worker to the drain plus the machine's restart. The job's timeout goes from 20 to 40 minutes.

- **Previews**, the deploy job in `.github/workflows/preview-worker.yml`: after the image is built and before the branch's old machines are destroyed, it runs the drain script with the branch's database URL and the app name `ctf-monitor-worker-preview`. The job's timeout goes from 20 to 40 minutes.
- `fly.toml`: `kill_timeout` is 300 seconds, set by `investigator-completion`. Nothing else changes. Production keeps `[[restart]] policy = "always"`.
- `README.md` describes the drain step, and says that a manual `flyctl deploy` or `flyctl machine restart` skips it.

## What a deploy looks like

- Idle worker: the drain completes in under a second, and the deploy takes about as long as today.
- A review in flight: the deploy waits for it, at most the review's ten minute deadline plus the worker's bookkeeping. Wake calls in that time find no row and send nothing. The work stays queued, and the new worker reviews it during its start window.
- Production's alias waits for the `deploy worker` check, so the new app goes live that much later.

## Out of scope

- Starting the new worker before the old one has finished, so that reviews never pause.
- A crash of the worker or its host. A review in flight is lost then. Saving a review's conversation so another worker can resume it is a separate change.
- A stop that does not go through the deploy jobs: `flyctl machine restart`, `flyctl secrets set`, host maintenance.
- A second credential for `/drain`. Whoever can read a database's `worker_wake` row can pause that worker for up to 15 minutes at a time.

## Acceptance

Integration tests use real Postgres and the real worker code, with provider fakes only. The worker runs as a child process where an exit code is asserted, as the existing W7 test does.

- D1. `POST /drain` with the right token answers 204 while a review is held open by the fake provider. A wrong or missing token answers 401. A job queued after the drain is not claimed. When the fake releases, the held review's verdict is stored with one review row and one attempt. The registration row is then gone and the process is still running.
- D2. A drained worker exits 0 within a few seconds of `SIGTERM`.
- D3. A drained worker that gets no signal exits with code 1 when its wait ends. The test passes a short wait.
- D4. A worker stopped by `SIGTERM` without a drain exits 0 even when a pass failed while it was stopping.
- D5. The drain script, against a real worker child process: it sends the drain, waits, and exits 0 after the row is gone. Its output holds neither the token nor the database URL.
- D6. The drain script sends nothing and exits 0 when there is no row, when the row is malformed and when the row's host belongs to another app. It exits 0 on a 404, on a refused connection and when its wait runs out, with a line that names the reason. The test passes a short wait.
- D7. A wake call made while the worker is drained sends nothing and the write commits.
- G1. `npm run check`, `npm run test:integration`, `npm run build` and `npm run test:coverage` pass.

## Live check by the lead

- E1. On the preview, with a review in flight, push a commit. The deploy job waits. The review finishes with one row and one attempt. The new machine then starts, registers and reviews queued work.
- E2. On the preview with an idle worker, the drain step takes a few seconds.
- E3. The first deploy after this change meets a worker without `/drain`. The script reports the 404 and the deploy goes on.
- E4. Production cannot be checked before merge. The lead watches the first production deploy with the user.

## Risks

- For up to about eleven minutes during a deploy no new review starts. A catch during play arrives that much later, and a submitted run waits that much longer.
- A deploy can take up to 12 minutes longer, and the production app's release waits with it.
- The deploy jobs now install dependencies and read the database.
- If the drain script's wait runs out, the deploy goes on and the review in flight is lost. The review deadline of ten minutes makes that unlikely.
- A drain followed by no deploy pauses reviews for 15 minutes.
- The first production deploy cannot drain the old worker, which has no `/drain`. A review in flight at that moment is lost, once.

## Evidence

- Deploy steps read by the lead at `f067863`: `.github/workflows/preview-worker.yml`, the `deploy worker` job in `.github/workflows/migrate-prod.yml`, `fly.toml`, `scripts/monitor-worker.ts`, `lib/monitor-wake-server.ts`.
- Fly documentation: `kill_timeout` "up to a maximum of 300 seconds (5 minutes)" and best-effort. Restart policy `always`: "never let it enter a `stopped` state, even when the main process exits cleanly". `on-failure`: "Try up to `max_retries` (default 10) times within a 5-minute window". `fly machine kill` sends SIGKILL only, and no command sends another signal without a stop deadline.
- Plan verification of the first draft, 2026-11-21. Verdict: not ready, five blocking findings.
  - Any worker that started drained whichever worker was registered, so a restarted older worker could drain a newer one.
  - With removal on clean exit, a signal from Fly for any reason could remove production's only machine.
  - The drain rode on a token that every preview database holds a copy of, and a drained machine was removed.
  - Reading the old row and writing the new one was not atomic, so two workers starting together could leave one that nothing drains.
  - Two acceptance items could not be built as written.
  - The verifier confirmed from the code that a pass in flight runs to its end after the loops are stopped, that the old worker's delete matches only its own row, and that wake calls read the row each time.
  - This draft is the verifier's simpler alternative, with two additions by the lead: the image is built before the drain, and a drained worker that sees no deploy restarts itself after 15 minutes.
