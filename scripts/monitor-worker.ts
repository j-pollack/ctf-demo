import { db } from "../lib/db";
import { hasPendingWork } from "../lib/monitor-jobs";
import { runMonitorWorkerOnce } from "../lib/monitor-worker";
import { LOOP_DURATIONS, createWorkerLoops, realClock } from "../lib/monitor-worker-loop";
import { startWakeEndpoint } from "../lib/monitor-wake-server";

// Reviews run concurrently: each loop claims its own job.
const REVIEW_LOOPS = 4;
const once = process.argv.includes("--once");
const loops = createWorkerLoops({
  pass: runMonitorWorkerOnce,
  hasPending: hasPendingWork,
  clock: realClock,
  durations: LOOP_DURATIONS,
});
// After a drain the worker idles, and it must not exit by itself: production restarts a machine on
// every exit. The limit is read from the environment only so a test can shorten it.
const DRAIN_IDLE_MS = Number(process.env.WORKER_DRAIN_IDLE_MS ?? 15 * 60_000);
let draining = false;
let signalled = false;
let idle = false;
const drain = () => {
  draining = true;
  loops.stop();
};
const onSignal = () => {
  signalled = true;
  loops.stop();
  if (idle) process.exit(0);
};
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, onSignal);

const count = once ? 1 : REVIEW_LOOPS;
console.log(JSON.stringify({ event: "monitor.worker.started", loops: count }));
// A single pass starts no server and registers nothing.
const endpoint = once
  ? undefined
  : await startWakeEndpoint(loops.wake, drain).catch(async (error) => {
      // The error's name only: a database error's detail can quote the row, which holds the token.
      console.error(
        JSON.stringify({ event: "monitor.worker.failed", error: (error as Error).name ?? "Error" }),
      );
      await db.end();
      process.exit(1);
    });
// The pool closes only after every loop has settled, so no review loses its connection mid-finish.
const results = once ? await Promise.allSettled([runMonitorWorkerOnce()]) : await loops.run(count);
// A worker whose loops have ended must not keep answering wakes.
await endpoint?.stop(draining);
for (const result of results)
  if (result.status === "rejected") {
    console.error(
      JSON.stringify({
        event: "monitor.worker.failed",
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      }),
    );
    // A worker that was drained and then signalled exits 0; one that was only signalled keeps 1.
    if (!draining) process.exitCode = 1;
  }
await db.end();
if (draining && !signalled) {
  idle = true;
  console.log(JSON.stringify({ event: "monitor.worker.drained" }));
  // Nothing else holds the event loop open now. Past the limit Fly restarts the worker.
  setTimeout(() => process.exit(1), DRAIN_IDLE_MS);
}
