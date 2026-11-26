import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LimitsCard } from "../app/admin/limits-card";
import { DEFAULT_LIMITS, LIMITS } from "../lib/limits";

const NOTE = "Applies from the next request. A run keeps the budget it started with.";
const REFUSAL = "That value was not saved. Enter a number inside the range shown for that field.";
const LABELS = [
  "Shared daily cap",
  "Run budget",
  "New runs per member per 24 hours",
  "New runs for all players per 24 hours",
  "Monitor allowance per run",
  "Final review allowance per run",
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

test("the card has a titled form per limit with a label, hidden key, input and Save button", () => {
  const html = render();
  assert.match(html, /Budgets and limits/);
  assert.ok(html.includes(NOTE));
  assert.equal((html.match(/<form/g) ?? []).length, LIMITS.length);
  LIMITS.forEach((limit, index) => {
    const markup = form(html, limit.key);
    assert.ok(markup, limit.key);
    const id = /<label[^>]*for="([^"]+)"/.exec(markup)?.[1];
    assert.ok(id, `${limit.key} has a label`);
    assert.ok(markup.includes(`id="${id}"`), "the label points at the input");
    assert.ok(markup.includes(`>${LABELS[index]}</label>`), LABELS[index]);
    assert.match(
      markup,
      /<input[^>]*type="number"[^>]*name="value"|<input[^>]*name="value"[^>]*type="number"/,
    );
    assert.match(markup, /<input[^>]*\srequired/);
    assert.match(markup, /<button[^>]*type="submit"[^>]*>Save<\/button>/);
    assert.match(markup, /<small>[^<]*to[^<]*<\/small>/, "a range hint");
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

test("a non-default limit shows its own value", () => {
  const html = render({
    limits: {
      ...DEFAULT_LIMITS,
      dailyCapMicrodollars: 12_500_000,
      runBudgetMicrodollars: 1_250_000,
      runsPerDay: 1,
      monitorRunAllowanceMicrodollars: 2_010_000,
    },
  });
  assert.equal(attr(form(html, "daily_cap_microdollars"), "value"), "12.5");
  assert.equal(attr(form(html, "run_budget_microdollars"), "value"), "1.25");
  assert.equal(attr(form(html, "runs_per_day"), "value"), "1");
  assert.equal(attr(form(html, "monitor_run_allowance_microdollars"), "value"), "2.01");
});

test("the card shows who changed a limit only for that limit", () => {
  const line = "Changed by admin@example.invalid · 2026-01-02 03:04 UTC";
  const html = render({ changedBy: { runs_per_day: line } });
  assert.ok(form(html, "runs_per_day").includes(line));
  assert.equal((html.match(/Changed by/g) ?? []).length, 1);
  assert.doesNotMatch(render(), /Changed by/);
});

test("the card shows the fixed refusal text only when refused", () => {
  assert.ok(render({ refused: true }).includes(REFUSAL));
  assert.match(render({ refused: true }), /<p role="alert">/);
  assert.ok(!render().includes(REFUSAL));
});
