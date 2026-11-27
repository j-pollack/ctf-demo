import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LimitsCard } from "../app/admin/limits-card";
import { DEFAULT_LIMITS, LIMITS } from "../lib/limits";

const NOTE = "Applies from the next request. A run keeps the budget it started with.";
const REFUSAL = "That value was not saved. Enter a value the field allows.";
const WARNING = "The leaderboard does not separate wins by investigator effort.";
const LABELS = [
  "Shared daily cap",
  "Run budget",
  "New runs per member per 24 hours",
  "New runs for all players per 24 hours",
  "Monitor allowance per run",
  "Final review allowance per run",
  "Environments open at once",
  "Name checks per member per day",
  "Sessions per run",
  "Auto-continue turns",
  "Response time limit (seconds)",
  "Attacker reasoning effort",
  "Investigator reasoning effort",
];
const render = (props: Partial<Parameters<typeof LimitsCard>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(LimitsCard, {
      action: () => {},
      limits: DEFAULT_LIMITS,
      changedBy: {},
      refused: false,
      ...props,
    }),
  );
const form = (html: string, key: string) =>
  html.split("<form").find((part) => part.includes(`name="key" value="${key}"`))!;
const valueInput = (markup: string) => /<input[^>]*name="value"[^>]*>/.exec(markup)![0];
const attr = (markup: string, name: string) =>
  new RegExp(`\\s${name}="([^"]*)"`).exec(valueInput(markup))?.[1];
const selected = (markup: string) =>
  [...markup.matchAll(/<option([^>]*)>([^<]*)<\/option>/g)]
    .filter((option) => / selected=""/.test(option[1]))
    .map((option) => /value="([^"]*)"/.exec(option[1])![1]);

test("the card has a form per limit with a label, hidden key, field and Save button", () => {
  const html = render();
  assert.match(html, /Budgets and limits/);
  assert.ok(html.includes(NOTE));
  assert.equal(LIMITS.length, 13);
  assert.equal((html.match(/<form/g) ?? []).length, 13);
  LIMITS.forEach((limit, index) => {
    const markup = form(html, limit.key);
    assert.ok(markup, limit.key);
    assert.ok(markup.includes('class="rule limit"'), "the row reuses the rule layout");
    const id = /<label[^>]*for="([^"]+)"/.exec(markup)?.[1];
    assert.ok(id, `${limit.key} has a label`);
    assert.ok(markup.includes(`id="${id}"`), "the label points at the field");
    assert.ok(markup.includes(`>${LABELS[index]}</label>`), LABELS[index]);
    assert.match(markup, /<button[^>]*type="submit"[^>]*>Save<\/button>/);
    if (limit.kind === "choice") {
      assert.match(markup, /<select[^>]*name="value"/);
      assert.doesNotMatch(markup, /<input[^>]*name="value"/);
    } else {
      assert.equal(attr(markup, "type"), "number");
      assert.equal(attr(markup, "required"), "");
      assert.match(markup, /<small>[^<]*to[^<]*<\/small>/, "a range hint");
    }
  });
});

test("money shows in dollars and counts as whole numbers, with bounds in the same unit", () => {
  const html = render();
  const expected: Record<string, [string, string, string, string]> = {
    daily_cap_microdollars: ["10", "0", "100", "0.01"],
    run_budget_microdollars: ["0.5", "0.01", "5", "0.01"],
    runs_per_day: ["3", "1", "50", "1"],
    total_runs_per_day: ["100", "0", "10000", "1"],
    monitor_run_allowance_microdollars: ["1.5", "0.1", "10", "0.01"],
    final_review_allowance_microdollars: ["1", "0", "10", "0.01"],
    environments_open: ["10", "1", "50", "1"],
    name_checks_per_day: ["20", "1", "200", "1"],
    sessions_per_run: ["8", "1", "32", "1"],
    auto_continue_turns: ["8", "0", "50", "1"],
    response_seconds: ["230", "5", "230", "1"],
  };
  for (const [key, [value, min, max, step]] of Object.entries(expected)) {
    const markup = form(html, key);
    assert.deepEqual(
      [attr(markup, "value"), attr(markup, "min"), attr(markup, "max"), attr(markup, "step")],
      [value, min, max, step],
      key,
    );
  }
});

test("a money row and a count row state their exact range", () => {
  const html = render();
  assert.ok(form(html, "run_budget_microdollars").includes("<small>$0.01 to $5</small>"));
  assert.ok(form(html, "daily_cap_microdollars").includes("<small>$0 to $100</small>"));
  assert.ok(form(html, "runs_per_day").includes("<small>1 to 50</small>"));
  assert.ok(form(html, "total_runs_per_day").includes("<small>0 to 10000</small>"));
  assert.ok(form(html, "response_seconds").includes("<small>5 to 230</small>"));
});

test("a non-default limit shows its own value", () => {
  const html = render({
    limits: {
      ...DEFAULT_LIMITS,
      dailyCapMicrodollars: 12_500_000,
      runBudgetMicrodollars: 1_250_000,
      runsPerDay: 1,
      monitorRunAllowanceMicrodollars: 2_010_000,
      sessionsPerRun: 4,
    },
  });
  assert.equal(attr(form(html, "daily_cap_microdollars"), "value"), "12.5");
  assert.equal(attr(form(html, "run_budget_microdollars"), "value"), "1.25");
  assert.equal(attr(form(html, "runs_per_day"), "value"), "1");
  assert.equal(attr(form(html, "monitor_run_allowance_microdollars"), "value"), "2.01");
  assert.equal(attr(form(html, "sessions_per_run"), "value"), "4");
});

test("an effort is a select of the three options with the current one selected", () => {
  const options = (markup: string) =>
    [...markup.matchAll(/<option[^>]*value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((match) => [
      match[1],
      match[2],
    ]);
  const defaults = render();
  for (const key of ["agent_effort", "investigator_effort"]) {
    assert.deepEqual(options(form(defaults, key)), [
      ["low", "Low"],
      ["medium", "Medium"],
      ["high", "High"],
    ]);
  }
  assert.deepEqual(selected(form(defaults, "agent_effort")), ["low"]);
  assert.deepEqual(selected(form(defaults, "investigator_effort")), ["high"]);
  const changed = render({
    limits: { ...DEFAULT_LIMITS, agentEffort: "high", investigatorEffort: "medium" },
  });
  assert.deepEqual(selected(form(changed, "agent_effort")), ["high"]);
  assert.deepEqual(selected(form(changed, "investigator_effort")), ["medium"]);
});

test("only the investigator effort carries the leaderboard warning", () => {
  const html = render();
  assert.equal((html.match(new RegExp(WARNING, "g")) ?? []).length, 1);
  assert.ok(form(html, "investigator_effort").includes(`<small>${WARNING}</small>`));
  assert.ok(!form(html, "agent_effort").includes(WARNING));
});

test("the card shows who changed a limit only for that limit", () => {
  const line = "Changed by admin@example.invalid · 2026-01-02 03:04 UTC";
  const html = render({ changedBy: { runs_per_day: line, agent_effort: line } });
  assert.ok(form(html, "runs_per_day").includes(line));
  assert.ok(form(html, "agent_effort").includes(line));
  assert.equal((html.match(/Changed by/g) ?? []).length, 2);
  assert.doesNotMatch(render(), /Changed by/);
});

test("the card shows the fixed refusal text only when refused", () => {
  assert.ok(render({ refused: true }).includes(REFUSAL));
  assert.match(render({ refused: true }), /<p role="alert">/);
  assert.ok(!render().includes(REFUSAL));
});
