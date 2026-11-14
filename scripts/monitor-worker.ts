import { setTimeout } from "node:timers/promises";
import { db } from "../lib/db";
import { runMonitorWorkerOnce } from "../lib/monitor-worker";

// Reviews run concurrently: each loop claims its own job.
const REVIEW_LOOPS = 4;
const once = process.argv.includes("--once");
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    stopping = true;
  });

async function reviewLoop() {
  try {
    do {
      const worked = await runMonitorWorkerOnce();
      if (!worked && !once && !stopping) await setTimeout(1000);
    } while (!once && !stopping);
  } catch (error) {
    // The other loops finish their current review, then stop.
    stopping = true;
    throw error;
  }
}

// The pool closes only after every loop has settled, so no review loses its connection mid-finish.
const loops = await Promise.allSettled(Array.from({ length: once ? 1 : REVIEW_LOOPS }, reviewLoop));
for (const loop of loops)
  if (loop.status === "rejected") {
    console.error(
      JSON.stringify({
        event: "monitor.worker.failed",
        error: loop.reason instanceof Error ? loop.reason.message : String(loop.reason),
      }),
    );
    process.exitCode = 1;
  }
await db.end();
