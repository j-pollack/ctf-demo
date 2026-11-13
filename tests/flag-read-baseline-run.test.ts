import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { buildSchedule } from "../scripts/flag-read-baseline";
import { main, prepareBaseline } from "../scripts/flag-read-baseline-run";
import { baselineSources } from "../scripts/flag-read-baseline-files";

const corpus = readFileSync("evals/flag-read/cases.json", "utf8");
const sources = { source: "frozen" };
const schedule = buildSchedule(corpus, sources);

test("candidate preflight requires the selected arm and freezes its policy and sources", () => {
  const strategy = "closed-world-presumption-v1";
  const candidate = buildSchedule(corpus, sources, strategy);
  assert.equal(candidate.policy.strategy, strategy);
  assert.equal(prepareBaseline(corpus, candidate, sources, 1_000_000, strategy).cases.length, 72);
  assert.throws(() => prepareBaseline(corpus, candidate, sources, 1_000_000), /differs/);
  assert.throws(() => prepareBaseline(corpus, schedule, sources, 1_000_000, strategy), /differs/);
  assert.throws(() => prepareBaseline(corpus, candidate, { source: "drift" }, 1_000_000, strategy));
  assert.throws(() => prepareBaseline(corpus, candidate, sources, 10_000_001, strategy), /Budget/);
  for (const execution of [
    { ...candidate.execution, investigatorDeadlineMs: 60_000 },
    { ...candidate.execution, reviewClaimMs: 90_000 },
    { ...candidate.execution, classifierDeadlineMs: 90_000 },
    { ...candidate.execution, provider: { ...candidate.execution.provider, only: ["wafer/us"] } },
    {
      ...candidate.execution,
      provider: { ...candidate.execution.provider, allow_fallbacks: true },
    },
  ])
    assert.throws(
      () => prepareBaseline(corpus, { ...candidate, execution }, sources, 1_000_000, strategy),
      /differs/,
    );
});

test("candidate CLI rejects ambiguous selection before any network or output", async (t) => {
  t.mock.method(globalThis, "fetch", () => assert.fail("unexpected network request"));
  await assert.rejects(
    main(["--dry-run", "--strategy", "closed-world-presumption-v1"]),
    /schedule/,
  );
  for (const option of ["--strategy", "--schedule"]) {
    await assert.rejects(main(["--dry-run", option]), /value/);
    await assert.rejects(main(["--dry-run", option, "one", option, "two"]), /once/);
  }
  await assert.rejects(main(["--dry-run", "--strategy", "focused"]), /strategy/);
});

test("candidate schedule generation and dry-run are offline and preserve the baseline", async (t) => {
  t.mock.method(globalThis, "fetch", () => assert.fail("unexpected network request"));
  const folder = mkdtempSync(join(tmpdir(), "ctf-candidate-schedule-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const path = join(folder, "schedule.json");
  const baselineBefore = readFileSync("evals/flag-read/baseline-schedule.json", "utf8");
  const args = [
    "--import",
    "tsx",
    "scripts/flag-read-baseline.ts",
    "--dry-run",
    path,
    "--strategy",
    "closed-world-presumption-v1",
  ];
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test" as const };
  const result = spawnSync(process.execPath, args, { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  const candidate = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(candidate.policy.strategy, "closed-world-presumption-v1");
  assert.deepEqual(candidate.cases, JSON.parse(baselineBefore).cases);
  await main(["--dry-run", "--strategy", "closed-world-presumption-v1", "--schedule", path], {});
  await assert.rejects(main(["--dry-run", "--schedule", path], {}), /differs/);
  // Drift must fail before live credential checks, output creation or provider access.
  candidate.policy.promptHash = "changed";
  writeFileSync(path, JSON.stringify(candidate));
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
        "closed-world-presumption-v1",
        "--schedule",
        path,
      ],
      {},
    ),
    /differs/,
  );
  assert.equal(existsSync(output), false);
  assert.notEqual(spawnSync(process.execPath, args, { encoding: "utf8", env }).status, 0);
  assert.equal(readFileSync("evals/flag-read/baseline-schedule.json", "utf8"), baselineBefore);
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
  await assert.rejects(main(["--live", "--budget-usd", "10"]), /output-dir/);
  await assert.rejects(main(["--dry-run", "--output-dir", "unused"]), /output-dir/);
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
    "evals/flag-read/baseline-schedule.json": JSON.stringify(buildSchedule(corpus, runtime)),
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
