import { test } from "node:test";
import assert from "node:assert/strict";
import { label } from "../app/run-format";

test("a model label drops the provider, or keeps an id that has none", () => {
  assert.equal(label("z-ai/glm-5.3-flash"), "glm-5.3-flash");
  assert.equal(label("glm-5.3-flash"), "glm-5.3-flash");
});
