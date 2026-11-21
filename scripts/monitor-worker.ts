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
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, loops.stop);

const count = once ? 1 : REVIEW_LOOPS;
console.log(JSON.stringify({ event: "monitor.worker.started", loops: count }));
// A single pass starts no server and registers nothing.
const endpoint = once
  ? undefined
  : await startWakeEndpoint(loops.wake).catch(async (error) => {
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
await endpoint?.stop();
for (const result of results)
  if (result.status === "rejected") {
    console.error(
      JSON.stringify({
        event: "monitor.worker.failed",
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      }),
    );
    process.exitCode = 1;
  }
await db.end();
