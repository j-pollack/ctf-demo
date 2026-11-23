# Worker drain: a deploy does not cost a review

- Worktree: `/Users/jonathan/Code/ctf/.worktrees/worker-handover`
- Branch: `feature/worker-handover`, stacked on `feature/investigator-completion`
- Status: contract verified with changes folded in, not built
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

- 2026-11-21: the deploy may wait for the old worker, with no new review starting meanwhile. "This seems fine."

## Decisions by the lead, open to the user

- The deploy waits for the old worker. The first draft started a new worker beside the old one and had the new one drain the old. The plan verifier found five blocking problems in it, among them an older worker draining a newer one and production left with no machine, and proposed this simpler design. It keeps production's deploy command, restart policy and rollback as they are.
- The cost is that no new review starts while the old worker finishes, at most about eleven minutes, and the deploy takes that much longer. Queued work is reviewed when the new worker starts.

## Goal

Before a deploy replaces the worker, the worker is told to drain. It takes no new work and finishes what it has. The deploy replaces it only when it is done.

## Design

### Drain endpoint

- The worker's HTTP server gains `POST /drain`, with the same bearer token as `/wake`. It answers 204 and stops the loops the way a signal does: no new pass starts, and passes in flight run to their end.
- When the loops have settled after a drain, the worker closes its server, removes its own registration row and ends its pool. It retries the row's delete until it succeeds, because the drain script waits on that row. It does not exit. It waits for a stop signal, and on `SIGTERM` or `SIGINT` it exits 0 at once.
- It does not exit because production's machine restarts on every exit, and a restart would put it back to work in the middle of a deploy.
- A signal that arrives after a drain and before the loops settle is remembered. The worker then exits 0 as soon as the loops settle and its row is removed, and never waits.
- If no signal arrives within 15 minutes of the drain completing, the worker exits with code 1. Both restart policies then restart it, and it registers and works again. A deploy that failed after the drain, or a drain sent by mistake, therefore pauses reviews for at most 15 minutes. The wait is a constant that a test can shorten through an environment variable read only for this purpose.
- A worker stopped by a signal without a drain behaves exactly as today, exit code included.
- `/drain` on a worker that is already draining answers 204 and changes nothing.

### Drain script

`scripts/drain-worker.ts`, run by the deploy jobs with the database URL and the worker's expected origin: `https://ctf-monitor-worker.fly.dev` for production and `https://ctf-monitor-worker-preview.fly.dev` for previews. Its wait limit is an argument with a default of 12 minutes.

1. It reads the `worker_wake` row. A query error here exits non-zero: nothing has been drained, so failing the deploy is safe. No row: it prints that there is nothing to drain and exits 0.
2. The row must parse, and its URL's origin must equal the origin it was given. Otherwise it prints why and exits 0 without sending anything. A preview's database starts as a copy of production's and can still hold production's row. This check is what keeps a preview's deploy from draining production.
3. It sends `POST /drain` to the row's URL with the path set to `/drain` and the row's token, with a 10 second timeout and no redirects. It adds the `fly-force-instance-id` header when the row has an instance.
   - 204: it polls the row every 2 seconds until the row is gone or its value has changed, for at most the wait limit, then exits 0. A query error while polling is retried until the limit. If the limit passes it prints a warning and exits 0, and the deploy goes on.
   - Anything else, including a 404 from a worker that predates this change, a refused connection and a timeout: it prints a reason code and exits 0. There is nothing to wait for.
4. It never prints the token or the database URL.

### Workflows

- **Production**, the `deploy worker` job in `.github/workflows/migrate-prod.yml`. `FLY_API_TOKEN` and `HEAD_SHA` move to the job's environment. The steps become:
  1. build and push the image: `flyctl deploy --build-only --push --remote-only --image-label "$HEAD_SHA"`;
  2. set up Node 24, run `npm ci` with `HUSKY: 0` as the migrate job does, and run the drain script with `DATABASE_URL_UNPOOLED` from the repository secret the migrate job already uses;
  3. release the built image: `flyctl deploy --ha=false --image "registry.fly.io/ctf-monitor-worker:$HEAD_SHA"`.

  Building first keeps the time with no worker to the drain plus the machine's restart. The job's timeout goes from 20 to 40 minutes.

- **Previews**, the deploy job in `.github/workflows/preview-worker.yml`: after the image is built and before the branch's old machines are destroyed, it sets up Node, runs `npm ci` and runs the drain script with the branch's database URL, which the drain step must receive from the Neon step as the replace step does. The job's timeout goes from 20 to 40 minutes.
- `fly.toml`: `kill_timeout` is 300 seconds, set by `investigator-completion`. Nothing else changes. Production keeps `[[restart]] policy = "always"`.
- `README.md` describes the drain step, and says that a manual `flyctl deploy` or `flyctl machine restart` skips it.

## What a deploy looks like

- Idle worker: the drain completes in under a second, and the deploy takes about as long as today.
- A review in flight: the deploy waits for it, at most the review's ten minute deadline plus the worker's bookkeeping. While the worker is still reviewing, its row is present and a wake call reaches it and does nothing. Once it is idle the row is gone and wake calls send nothing. Either way the work stays queued, and the new worker reviews it during its start window.
- Production's alias waits for the `deploy worker` check, so the new app goes live that much later.

## Out of scope

- Starting the new worker before the old one has finished, so that reviews never pause.
- A crash of the worker or its host. A review in flight is lost then. Saving a review's conversation so another worker can resume it is a separate change.
- A stop that does not go through the deploy jobs: `flyctl machine restart`, `flyctl secrets set`, host maintenance.
- A second credential for `/drain`. Whoever can read a database's `worker_wake` row can pause that worker for up to 15 minutes at a time.

## Acceptance

Integration tests use real Postgres and the real worker code, with provider fakes only. The worker runs as a child process with no Fly environment, as the existing W7 test does, so it registers a loopback address and the drain script is given that origin. A new preload gives the fake provider a review it holds open until the test creates a control file.

- D1. `POST /drain` with the right token answers 204 while a review is held open. A wrong or missing token answers 401. A job queued after the drain stays unclaimed for longer than one idle poll while the review is held, and after it is released. When the fake releases, the held review's verdict is stored with one review row and one attempt. The registration row is then gone and the process is still running.
- D2. A drained, idle worker exits 0 within a few seconds of `SIGTERM`.
- D3. A drained worker that gets no signal exits with code 1 when its wait ends. The test shortens the wait.
- D4. A worker that receives `SIGTERM` after a drain and while its review is still held exits 0 when the review is released, without waiting.
- D5. The drain script, against a real worker child process: it sends the drain, waits, and exits 0 after the row is gone. Its output holds neither the token nor the database URL.
- D6. The drain script sends nothing and exits 0 when there is no row, when the row is malformed and when the row's origin is not the one given. It exits 0 with a reason line on a 404, on a refused connection and when its wait runs out. It exits non-zero when the first read of the row fails. The test shortens the wait.
- G1. `npm run check`, `npm run test:integration`, `npm run build` and `npm run test:coverage` pass. W7 passes unchanged.

## Live check by the lead

- E1. On the preview, with a review in flight, push a commit. The deploy job waits. The review finishes with one row and one attempt. The new machine then starts, registers and reviews queued work.
- E2. On the preview with an idle worker, the drain step takes a few seconds.
- E3. The first preview deploy after this change meets a worker without `/drain`. The script reports the 404 and the deploy goes on.
- E4. Production cannot be checked before merge. Its database has no `worker_wake` row until this pull request deploys, so the first production deploy reports nothing to drain. The lead watches it with the user.

## Risks

- For up to about eleven minutes during a deploy no new review starts. A catch during play arrives that much later, and a submitted run waits that much longer.
- A deploy can take up to 12 minutes longer, and the production app's release waits with it.
- The deploy jobs now install dependencies and read the database.
- If the drain script's wait runs out, the deploy goes on and the review in flight is lost. The review deadline of ten minutes makes that unlikely.
- A drain followed by no deploy pauses reviews for 15 minutes.
- The first production deploy cannot drain the old worker, which has neither a registration nor `/drain`. A review in flight at that moment is lost, once.
- A drained worker that crashes is restarted by Fly and registers again. The script then sees the row change and lets the deploy go on, which can interrupt a review the restarted worker has just claimed.
- Whether Vercel's wait on the `deploy worker` check has a time limit shorter than 40 minutes is not known.

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
- Second plan verification, 2026-11-21. Verdict: ready with changes, three blocking findings, all folded in.
  - The script's host check rejected every worker a test could start. The script now takes the expected origin.
  - An acceptance item said a signalled worker exits 0 whatever its passes returned, which contradicts the code and could not be tested. It is removed, and a signalled worker keeps today's exit code.
  - A database error in the script and a signal during a drain were unspecified. Both are stated above.
  - Also folded in: the delete of the row is retried, the workflow steps' needs, the wake sentence, the expectation for the first production deploy, and the test parameters.
  - Not verified, because they depend on Fly or Vercel: that `flyctl deploy --image` signals and replaces a drained worker as the single-command deploy does, and Vercel's limit on the check wait.
- Build, 2026-11-21. The lead ran the gates on the final tree: check 396 passed, integration 387 passed, build passed, coverage 396 passed. Both workflow files parse and their steps are in the contract's order. The workflows have not run.
- Code review, 2026-11-21. Verdict: approve with fixes, no blocking finding. The reviewer traced every exit path of the worker script and of the drain script. Applied: D5 holds a review open and shows the script waiting on it; a drain without the token is shown to have no effect; the retried delete has a test, D7; the held-review fake validates its request; a drained and signalled worker exits 0 even if a loop rejected; the script rejects a bad wait or origin before it reads the database; the drain handler is a required parameter.
- A departure from this contract's Workflows section, taken from the review: the Fly API token is set only on the steps that run `flyctl`, not at job level, so `npm ci` and the drain script never see it.
- D1 asserts the job is `caught-up` with one review row. The job's `attempts` is reset to 0 on a successful review, so it cannot show "one attempt". One review row per claim shows the review was not repeated.
- Live check on pull request 37's preview, 2026-11-21.
  - E3. The deploy for `e51aede` was the first run of the changed workflow. Its drain step met a worker from before this change, logged `worker.drain.failed` with reason `status 404`, and the deploy went on. The new worker registered, and through Fly `POST /drain` with no token answered 401.
  - E2. The deploy for `c9c19af` drained that worker. The script logged `worker.drain.sent` at 05:36:54.95 UTC and `worker.drain.drained` at 05:36:57.04, on its first poll. The step took 4 seconds and the machine was replaced 10 seconds later.
  - E1, first attempt, 2026-11-23 on the deploy for `f771209`. A command that names the flag file completed at 07:38:21.7 UTC and queued an investigated review. The drain ran from 07:38:24.0 to 07:38:27.1 and found no review in flight: the worker had not claimed the job yet. The replaced worker reviewed it at 07:38:57.8, one attempt, verdict allow. No review was lost, but no review was in flight during the drain either.
- CI on `e51aede` failed once on a test from the tool annotation step that raced two passes, and passed on a rerun. `c9c19af` makes that test deterministic, and CI is green on it.
