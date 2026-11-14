import { test } from "node:test";
import assert from "node:assert/strict";
import { safeNextPath, signInPath } from "../app/sign-in-path";

test("next falls back to /play unless it is a plain path on this site", () => {
  for (const value of [
    "//evil.example",
    "/\\evil.example",
    "https://evil.example",
    "javascript:alert(1)",
    "",
    null,
    undefined,
    "/play\nSet-Cookie: x",
    "/play\t",
    `/${"a".repeat(599)}`,
    "/signin",
    "/signin?next=/play",
    "/signin/",
    " /play",
    "/%5Cevil.example",
    "/%2F%2Fevil.example",
    "/%2f%2fevil.example/path",
    "/%E0%A4%A",
    "play",
    "?next=/rank",
  ])
    assert.equal(safeNextPath(value), "/play", JSON.stringify(value));
});

test("a path whose dot segments resolve to another site falls back to /play", () => {
  for (const value of [
    "/.//evil.example",
    "/..//evil.example",
    "/%2e//evil.example",
    "/%2E%2E//evil.example",
    "/a/..//evil.example",
    "/%252e//evil.example",
  ])
    assert.equal(safeNextPath(value), "/play", JSON.stringify(value));
});

test("a path with dot segments comes back resolved, never raw", () => {
  assert.equal(safeNextPath("/runs/../rank"), "/rank");
  assert.equal(safeNextPath("/a/./b?x=1#y"), "/a/b?x=1#y");
});

test("a plain path on this site comes back unchanged", () => {
  for (const value of ["/runs/abc?session=1", "/rank", "/play", "/play#frag", "/rules?x=%20y"])
    assert.equal(safeNextPath(value), value);
  assert.equal(
    safeNextPath(`/${"a".repeat(511)}`),
    `/${"a".repeat(511)}`,
    "512 characters is allowed",
  );
});

test("the sign-in link names a validated next and never nests itself", () => {
  assert.equal(signInPath("/rank"), "/signin?next=%2Frank");
  assert.equal(signInPath("/runs/abc?session=1"), "/signin?next=%2Fruns%2Fabc%3Fsession%3D1");
  assert.equal(signInPath("/signin?next=/rank"), "/signin?next=%2Fplay");
  assert.equal(signInPath("//evil.example"), "/signin?next=%2Fplay");
});
