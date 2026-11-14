import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_MODEL, GameError, MODELS, publicAgentSettings } from "../lib/policy";

const other = MODELS.find((model) => model !== AGENT_MODEL)!;

test("public agent settings pin the model passed in, not the default", () => {
  assert.deepEqual(publicAgentSettings({}, other), { agentModel: other, agentEffort: "low" });
  assert.deepEqual(publicAgentSettings({ agentModel: other }, other), {
    agentModel: other,
    agentEffort: "low",
  });
});

test("public agent settings refuse a body naming any other model", () => {
  for (const [named, pinned] of [
    [AGENT_MODEL, other],
    [other, AGENT_MODEL],
    [null, other],
  ])
    assert.throws(
      () => publicAgentSettings({ agentModel: named }, pinned!),
      (error) =>
        error instanceof GameError &&
        error.status === 400 &&
        error.message === "The agent model cannot be changed.",
    );
});

test("public agent settings still refuse a non-default effort", () => {
  assert.throws(
    () => publicAgentSettings({ agentEffort: "high" }, other),
    (error) => error instanceof GameError && error.status === 400,
  );
});
