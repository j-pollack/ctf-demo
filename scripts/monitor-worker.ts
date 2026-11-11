import { setTimeout } from "node:timers/promises";
import { db } from "../lib/db";
import { runMonitorWorkerOnce } from "../lib/monitor-worker";

const once = process.argv.includes("--once");
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    stopping = true;
  });

try {
  do {
    const worked = await runMonitorWorkerOnce();
    if (!worked && !once && !stopping) await setTimeout(1000);
  } while (!once && !stopping);
} catch (error) {
  console.error(
    JSON.stringify({
      event: "monitor.worker.failed",
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
} finally {
  await db.end();
}
