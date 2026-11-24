import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkerLoops, type LoopClock, type LoopDurations } from "../lib/monitor-worker-loop";

const durations: LoopDurations = {
  startWindowMs: 100,
  wakeLingerMs: 30,
  progressLimitMs: 450,
  safetyIntervalMs: 6000,
  idlePollMs: 10,
};

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

function fakeClock() {
  let time = 0;
  const timers: { at: number; done: () => void }[] = [];
  const clock: LoopClock = {
    now: () => time,
    sleep: (ms, signal) =>
      new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        const timer = { at: time + ms, done: resolve };
        timers.push(timer);
        signal.addEventListener("abort", () => resolve(), { once: true });
      }),
  };
  async function advance(ms: number) {
    const end = time + ms;
    for (;;) {
      await settle();
      const due = timers.filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      time = Math.max(time, due.at);
      due.done();
    }
    time = end;
    await settle();
  }
  return { clock, advance };
}

function setup(options: { pending?: () => boolean; work?: () => boolean } = {}) {
  const { clock, advance } = fakeClock();
  const counts = { passes: 0, queries: 0 };
  let hold: Promise<void> | undefined;
  let release = () => {};
  const loops = createWorkerLoops({
    clock,
    durations,
    pass: async () => {
      counts.passes++;
      return options.work?.() ?? false;
    },
    hasPending: async () => {
      counts.queries++;
      const held = hold;
      hold = undefined;
      await held;
      return options.pending?.() ?? false;
    },
  });
  const done = loops.run(1);
  return {
    loops,
    advance,
    counts,
    done,
    holdNextQuery: () => (hold = new Promise<void>((resolve) => (release = resolve))),
    releaseQuery: () => release(),
  };
}

test("an idle loop polls through the start window and then runs no pass or query", async () => {
  const run = setup();
  await run.advance(95);
  assert.ok(run.counts.passes >= 8, "polls every idle interval while the process is new");
  await run.advance(10);
  await run.advance(10);
  const passes = run.counts.passes;
  const queries = run.counts.queries;
  await run.advance(5000);
  assert.deepEqual([run.counts.passes, run.counts.queries], [passes, queries]);
  run.loops.stop();
  await run.done;
});

test("pending work keeps polling until the limit, then a dormant loop waits for the safety pass", async () => {
  const run = setup({ pending: () => true });
  await run.advance(400);
  const during = run.counts.passes;
  await run.advance(40);
  assert.ok(run.counts.passes > during, "still polling before the progress limit");
  await run.advance(100);
  const frozen = run.counts.passes;
  await run.advance(5000);
  assert.equal(run.counts.passes, frozen, "dormant at the limit");
  await run.advance(1100);
  assert.equal(run.counts.passes, frozen + 1, "one pass at the safety interval");
  run.loops.stop();
  await run.done;
});

test("a pass that does work counts as progress", async () => {
  let works = false;
  const run = setup({ pending: () => true, work: () => works && !(works = false) });
  await run.advance(430);
  works = true;
  await run.advance(20);
  const before = run.counts.passes;
  await run.advance(200);
  assert.ok(run.counts.passes > before, "progress at 440 extends the pending window past 450");
  run.loops.stop();
  await run.done;
});

test("a wake counts as progress, and a wake after stop does nothing", async () => {
  const run = setup({ pending: () => true });
  await run.advance(430);
  run.loops.wake();
  await run.advance(100);
  const before = run.counts.passes;
  await run.advance(200);
  assert.ok(run.counts.passes > before, "the wake at 430 extends the pending window past 450");
  run.loops.stop();
  run.loops.wake();
  await run.done;
});

test("a wake wakes a dormant loop and keeps it awake for the linger", async () => {
  const run = setup();
  await run.advance(300);
  const dormant = run.counts.passes;
  run.loops.wake();
  await run.advance(25);
  assert.ok(run.counts.passes > dormant + 1, "polls during the linger");
  await run.advance(50);
  const after = run.counts.passes;
  await run.advance(1000);
  assert.equal(run.counts.passes, after, "dormant again after the linger");
  run.loops.stop();
  await run.done;
});

test("a wake that arrives during the pending check starts another pass", async () => {
  const run = setup();
  await run.advance(300);
  run.holdNextQuery();
  run.loops.wake();
  await run.advance(31);
  const queries = run.counts.queries;
  await run.advance(5);
  assert.equal(run.counts.queries, queries, "the loop is inside the held query");
  run.loops.wake();
  const passes = run.counts.passes;
  run.releaseQuery();
  await run.advance(1);
  assert.ok(run.counts.passes > passes, "the wake during the query led to a pass");
  run.loops.stop();
  await run.done;
});

test("a stop signal ends a dormant loop at once", async () => {
  const run = setup();
  await run.advance(300);
  run.loops.stop();
  const results = await run.done;
  assert.equal(results[0].status, "fulfilled");
});

test("a failed pass stops every loop and surfaces the error", async () => {
  const { clock, advance } = fakeClock();
  const loops = createWorkerLoops({
    clock,
    durations,
    pass: async () => {
      throw new Error("boom");
    },
    hasPending: async () => false,
  });
  const done = loops.run(3);
  await advance(10);
  const results = await done;
  assert.deepEqual(
    results.map((result) => result.status),
    ["rejected", "rejected", "rejected"],
  );
});
