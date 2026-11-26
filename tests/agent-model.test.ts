import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_MODEL, GameError, MODELS, publicAgentSettings } from "../lib/policy";

const other = MODELS.find((model) => model !== AGENT_MODEL)!;

test("public agent settings pin the model passed in, not the default", () => {
  assert.deepEqual(publicAgentSettings({}, other, "low"), {
    agentModel: other,
    agentEffort: "low",
  });
  assert.deepEqual(publicAgentSettings({ agentModel: other }, other, "low"), {
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
      () => publicAgentSettings({ agentModel: named }, pinned!, "low"),
      (error) =>
        error instanceof GameError &&
        error.status === 400 &&
        error.message === "The agent model cannot be changed.",
    );
});

test("public agent settings pin the effort passed in and refuse any other", () => {
  assert.deepEqual(publicAgentSettings({}, other, "high"), {
    agentModel: other,
    agentEffort: "high",
  });
  assert.deepEqual(publicAgentSettings({ agentEffort: "high" }, other, "high"), {
    agentModel: other,
    agentEffort: "high",
  });
  for (const named of ["low", "medium", null, 3])
    assert.throws(
      () => publicAgentSettings({ agentEffort: named }, other, "high"),
      (error) =>
        error instanceof GameError &&
        error.status === 400 &&
        error.message === "The agent reasoning effort cannot be changed.",
    );
});
