import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { buildSchedule } from "../scripts/flag-read-baseline";
import { main, prepareBaseline } from "../scripts/flag-read-baseline-run";
import { baselineSources } from "../scripts/flag-read-baseline-files";
import { syntheticHeldoutCorpus } from "./fixtures/heldout-corpus";

const corpus = readFileSync("evals/flag-read/cases.json", "utf8");
const sources = { source: "frozen" };
const COMMITTED_SCHEDULE =
  "evals/flag-read/closed-world-presumption-digitalocean-90s-repeatability-schedule.json";
const schedule = buildSchedule(corpus, sources);

test("held-out preflight refuses cross-split schedules and accepts the explicit frozen split", () => {
  const synthetic = syntheticHeldoutCorpus(corpus);
  const strategy = "closed-world-presumption";
  const heldout = buildSchedule(synthetic, sources, strategy, "test");
  const dev = buildSchedule(synthetic, sources, strategy);
  assert.equal(
    prepareBaseline(synthetic, heldout, sources, 2_000_000, strategy, "test").cases.length,
    40,
  );
  assert.throws(() => prepareBaseline(synthetic, heldout, sources, 2_000_000, strategy), /differs/);
  assert.throws(
    () => prepareBaseline(synthetic, dev, sources, 2_000_000, strategy, "test"),
    /differs/,
  );
  assert.throws(
    () => prepareBaseline(synthetic, heldout, sources, 6_000_001, strategy, "test"),
    /Budget/,
  );
});

test("held-out CLI requires explicit split and schedule before live access", async (t) => {
  t.mock.method(globalThis, "fetch", () => assert.fail("unexpected network request"));
  await assert.rejects(main(["--dry-run", "--split", "test"]), /schedule/);
  await assert.rejects(main(["--dry-run", "--split", "other"]), /split/);
  const folder = mkdtempSync(join(tmpdir(), "ctf-heldout-schedule-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const path = join(folder, "schedule.json");
  const args = [
    "--import",
    "tsx",
    "scripts/flag-read-baseline.ts",
    "--dry-run",
    path,
    "--strategy",
    "closed-world-presumption",
    "--split",
    "test",
  ];
  const generated = spawnSync(process.execPath, args, {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test" },
  });
  assert.equal(generated.status, 0, generated.stderr);
  assert.match(generated.stdout, /40 cases; proposed cap \$6/);
  const frozen = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(frozen.cases.length, 40);
  assert.equal(frozen.split, "test");
  await main(
    ["--dry-run", "--strategy", "closed-world-presumption", "--split", "test", "--schedule", path],
    {},
  );
  await assert.rejects(
    main(["--dry-run", "--strategy", "closed-world-presumption", "--schedule", path], {}),
    /differs/,
  );
  const output = join(folder, "not-created");
  await assert.rejects(
    main(
      [
        "--live",
        "--budget-usd",
        "2",
        "--output-dir",
        output,
        "--strategy",
        "closed-world-presumption",
        "--schedule",
        path,
      ],
      {},
    ),
    /differs/,
  );
  assert.equal(existsSync(output), false);
  assert.notEqual(spawnSync(process.execPath, args, { encoding: "utf8" }).status, 0);
});

test("production preflight freezes its policy and sources", () => {
  const strategy = "closed-world-presumption";
  const frozen = buildSchedule(corpus, sources, strategy);
  assert.equal(frozen.policy.strategy, strategy);
  assert.equal(prepareBaseline(corpus, frozen, sources, 1_000_000, strategy).cases.length, 72);
  assert.throws(
    () =>
      prepareBaseline(
        corpus,
        { ...frozen, policy: { ...frozen.policy, promptHash: "changed" } },
        sources,
        1_000_000,
        strategy,
      ),
    /differs/,
  );
  assert.throws(() => prepareBaseline(corpus, frozen, { source: "drift" }, 1_000_000, strategy));
  assert.throws(() => prepareBaseline(corpus, frozen, sources, 10_000_001, strategy), /Budget/);
  for (const execution of [
    { ...frozen.execution, investigatorDeadlineMs: 60_000 },
    { ...frozen.execution, reviewClaimMs: 90_000 },
    { ...frozen.execution, classifierDeadlineMs: 90_000 },
    { ...frozen.execution, provider: { ...frozen.execution.provider, only: ["wafer/us"] } },
    {
      ...frozen.execution,
      provider: { ...frozen.execution.provider, allow_fallbacks: true },
    },
  ])
    assert.throws(
      () => prepareBaseline(corpus, { ...frozen, execution }, sources, 1_000_000, strategy),
      /differs/,
    );
});

test("CLI rejects ambiguous selection before any network or output", async (t) => {
  t.mock.method(globalThis, "fetch", () => assert.fail("unexpected network request"));
  await assert.rejects(main(["--dry-run"]), /schedule/);
  await assert.rejects(main(["--dry-run", "--strategy", "closed-world-presumption"]), /schedule/);
  for (const option of ["--strategy", "--schedule", "--split"]) {
    await assert.rejects(main(["--dry-run", option]), /value/);
    await assert.rejects(main(["--dry-run", option, "one", option, "two"]), /once/);
  }
  await assert.rejects(main(["--dry-run", "--strategy", "focused"]), /strategy/);
});

test("schedule generation and dry-run are offline and preserve the committed schedule", async (t) => {
  t.mock.method(globalThis, "fetch", () => assert.fail("unexpected network request"));
  const folder = mkdtempSync(join(tmpdir(), "ctf-generated-schedule-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const path = join(folder, "schedule.json");
  const baselineBefore = readFileSync(COMMITTED_SCHEDULE, "utf8");
  const args = [
    "--import",
    "tsx",
    "scripts/flag-read-baseline.ts",
    "--dry-run",
    path,
    "--strategy",
    "closed-world-presumption",
  ];
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test" as const };
  const result = spawnSync(process.execPath, args, { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  const generated = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(generated.policy.strategy, "closed-world-presumption");
  assert.deepEqual(generated.cases, JSON.parse(baselineBefore).cases);
  await main(["--dry-run", "--strategy", "closed-world-presumption", "--schedule", path], {});
  // Drift must fail before live credential checks, output creation or provider access.
  generated.policy.promptHash = "changed";
  writeFileSync(path, JSON.stringify(generated));
  const output = join(folder, "never-created");
  await assert.rejects(
    main(
      [
        "--live",
        "--budget-usd",
        "1",
        "--output-dir",
        output,
        "--strategy",
        "closed-world-presumption",
        "--schedule",
        path,
      ],
      {},
    ),
    /differs/,
  );
  assert.equal(existsSync(output), false);
  assert.notEqual(spawnSync(process.execPath, args, { encoding: "utf8", env }).status, 0);
  assert.equal(readFileSync(COMMITTED_SCHEDULE, "utf8"), baselineBefore);
});

test("live preflight rejects all frozen surface drift and invalid budgets", () => {
  const prepared = prepareBaseline(corpus, schedule, sources, 10_000_000);
  assert.equal(prepared.cases.length, 72);
  assert.deepEqual(
    prepared.cases.map((item) => item.id),
    schedule.cases.map((item) => item.id),
  );
  assert.ok(prepared.cases.every((item) => item.observationTimes));
  for (const budget of [0, -1, 0.5, Infinity, NaN, 10_000_001])
    assert.throws(() => prepareBaseline(corpus, schedule, sources, budget));
  assert.throws(() => prepareBaseline(corpus + " ", schedule, sources));
  assert.throws(() => prepareBaseline(corpus, schedule, { source: "changed" }));
  assert.throws(() => prepareBaseline(corpus, { ...schedule, sources: {} }, sources));
  assert.throws(() =>
    prepareBaseline(corpus, { ...schedule, cases: [...schedule.cases].reverse() }, sources),
  );
  assert.throws(() =>
    prepareBaseline(
      corpus,
      { ...schedule, policy: { ...schedule.policy, effort: "low" } },
      sources,
    ),
  );
});

test("live CLI rejects missing authorization and ambiguous arguments before network", async (t) => {
  t.mock.method(globalThis, "fetch", () => {
    assert.fail("unexpected network request");
  });
  await assert.rejects(main(["--live"]), /budget/);
  await assert.rejects(
    main(["--live", "--budget-usd", "10", "--schedule", COMMITTED_SCHEDULE]),
    /output-dir/,
  );
  await assert.rejects(
    main(["--dry-run", "--output-dir", "unused", "--schedule", COMMITTED_SCHEDULE]),
    /output-dir/,
  );
  await assert.rejects(
    main(["--live", "--budget-usd", "10", "--output-dir", "one", "--output-dir", "two"]),
    /once/,
  );
});

test("runner cannot validate another checkout while executing its own imports", (t) => {
  const other = mkdtempSync(join(tmpdir(), "ctf-other-checkout-"));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  const runtime = baselineSources();
  for (const [path, content] of Object.entries({
    ...runtime,
    "evals/flag-read/cases.json": corpus,
  })) {
    mkdirSync(dirname(join(other, path)), { recursive: true });
    writeFileSync(join(other, path), content);
  }
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      resolve("scripts/flag-read-baseline-run.ts"),
      "--dry-run",
    ],
    { cwd: other, encoding: "utf8", env: { ...process.env, NODE_TEST_CONTEXT: undefined } },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /runner.*checkout/);
});
