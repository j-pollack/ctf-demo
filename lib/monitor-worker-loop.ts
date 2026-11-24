import { setTimeout as sleepFor } from "node:timers/promises";

export const START_WINDOW_MS = 10 * 60_000;
export const WAKE_LINGER_MS = 30_000;
export const PROGRESS_LIMIT_MS = 45 * 60_000;
export const SAFETY_INTERVAL_MS = 6 * 60 * 60_000;
export const IDLE_POLL_MS = 1_000;

export type LoopDurations = {
  startWindowMs: number;
  wakeLingerMs: number;
  progressLimitMs: number;
  safetyIntervalMs: number;
  idlePollMs: number;
};

export const LOOP_DURATIONS: LoopDurations = {
  startWindowMs: START_WINDOW_MS,
  wakeLingerMs: WAKE_LINGER_MS,
  progressLimitMs: PROGRESS_LIMIT_MS,
  safetyIntervalMs: SAFETY_INTERVAL_MS,
  idlePollMs: IDLE_POLL_MS,
};

export type LoopClock = {
  now(): number;
  // Resolves when the time passes or the signal aborts; never rejects.
  sleep(ms: number, signal: AbortSignal): Promise<void>;
};

export const realClock: LoopClock = {
  now: () => Date.now(),
  sleep: (ms, signal) => sleepFor(ms, undefined, { signal, ref: true }).catch(() => undefined),
};

export type LoopDeps = {
  // Runs one worker pass and reports whether it did work.
  pass: () => Promise<boolean>;
  hasPending: () => Promise<boolean>;
  clock: LoopClock;
  durations: LoopDurations;
};

// Loops that share one gate: they poll while work may exist and wait, running no query, otherwise.
export function createWorkerLoops({ pass, hasPending, clock, durations }: LoopDeps) {
  const startedAt = clock.now();
  let lastWake = Number.NEGATIVE_INFINITY;
  let lastProgress = startedAt;
  let wakes = 0;
  let stopped = false;
  let gate = new AbortController();

  function wake() {
    if (stopped) return;
    lastWake = lastProgress = clock.now();
    wakes++;
    gate.abort();
    gate = new AbortController();
  }

  function stop() {
    stopped = true;
    gate.abort();
  }

  async function shouldPoll() {
    const now = clock.now();
    if (now - startedAt < durations.startWindowMs || now - lastWake < durations.wakeLingerMs)
      return true;
    if (now - lastProgress >= durations.progressLimitMs) return false;
    const seen = wakes;
    const pending = await hasPending();
    // A wake that arrived during the query is not lost.
    return pending || wakes !== seen;
  }

  async function loop() {
    try {
      while (!stopped) {
        if (await shouldPoll()) {
          if (stopped) break;
          if (await pass()) lastProgress = clock.now();
          else await clock.sleep(durations.idlePollMs, gate.signal);
          continue;
        }
        const signal = gate.signal;
        await clock.sleep(durations.safetyIntervalMs, signal);
        // Neither a wake nor a stop: the safety net runs one pass.
        if (!signal.aborted && !stopped && (await pass())) lastProgress = clock.now();
      }
    } catch (error) {
      // The other loops finish their current review, then stop.
      stop();
      throw error;
    }
  }

  return {
    wake,
    stop,
    run: (count: number) => Promise.allSettled(Array.from({ length: count }, loop)),
  };
}
