import assert from "node:assert/strict";
import { test } from "node:test";
import { isAdmin } from "../lib/admin";

test("admin access requires the database flag on a signed-in user", () => {
  assert.equal(isAdmin({ isAdmin: true, isAnonymous: false }), true);
  assert.equal(isAdmin({ isAdmin: true }), true);
  assert.equal(isAdmin({ isAdmin: true, isAnonymous: true }), false);
  assert.equal(isAdmin({ isAdmin: false }), false);
  assert.equal(isAdmin({ isAdmin: null }), false);
  assert.equal(isAdmin({}), false);
  assert.equal(isAdmin(undefined), false);
});
