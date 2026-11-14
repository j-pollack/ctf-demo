import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentModelCard } from "../app/admin/agent-model-card";

const models = ["a/alpha", "b/beta", "c/gamma"];
const render = (props: Partial<Parameters<typeof AgentModelCard>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(AgentModelCard, {
      action: () => {},
      models,
      current: "b/beta",
      changedBy: "Changed by admin@example.invalid · 2026-01-02 03:04 UTC",
      refused: false,
      ...props,
    }),
  );
const REFUSAL = "That model was not saved. It must be on the allowlist and served by the catalog.";

test("the card selects the current model among all allowed models", () => {
  const html = render();
  assert.match(html, /Attacker model/);
  assert.match(html, /<select[^>]*name="model"/);
  for (const model of models) assert.match(html, new RegExp(`<option[^>]*value="${model}"`));
  assert.equal((html.match(/selected/g) ?? []).length, 1);
  assert.match(
    html,
    /<option[^>]*value="b\/beta"[^>]*selected|<option[^>]*selected[^>]*value="b\/beta"/,
  );
  assert.match(html, /<label[^>]*for=/);
  assert.match(html, /<button[^>]*type="submit"/);
});

test("the card shows who changed the model, or nothing when never changed", () => {
  assert.match(render(), /Changed by admin@example\.invalid · 2026-01-02 03:04 UTC/);
  assert.doesNotMatch(render({ changedBy: null }), /Changed by/);
});

test("the card shows the fixed refusal text only when refused", () => {
  assert.ok(render({ refused: true }).includes(REFUSAL));
  assert.ok(!render().includes(REFUSAL));
});
