// Child-process worker for the idle-wake tests: the shared worker preload, plus a clock that jumps
// past the start window so the loops can go dormant without a ten-minute wait.
import "./async-worker-preload";

const realNow = Date.now.bind(Date);
let jump = 0;
Date.now = () => realNow() + jump;
setTimeout(
  () => {
    jump = 11 * 60_000;
  },
  Number(process.env.IDLE_WORKER_JUMP_MS ?? 500),
).unref();
