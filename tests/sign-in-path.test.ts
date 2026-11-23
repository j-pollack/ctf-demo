import { test } from "node:test";
import assert from "node:assert/strict";
import {
  safeNextPath,
  signInPath,
  accountPath,
  accountSignInPath,
  signOutDestination,
} from "../app/sign-in-path";

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

test("the account link names a validated next, so a new player returns where they were going", () => {
  assert.equal(accountPath("/play"), "/account?next=%2Fplay");
  assert.equal(accountPath("/runs/abc?session=1"), "/account?next=%2Fruns%2Fabc%3Fsession%3D1");
  assert.equal(accountPath("//evil.example"), "/account?next=%2Fplay");
});

test("a signed-out visit to the account page keeps its link outcome through sign-in", () => {
  assert.equal(accountSignInPath({}), "/signin?next=%2Faccount");
  assert.equal(
    accountSignInPath({ email: "confirmed" }),
    "/signin?next=%2Faccount%3Femail%3Dconfirmed",
  );
  assert.equal(
    accountSignInPath({ next: "/play", email: "changed", error: "TOKEN_EXPIRED", other: "x" }),
    "/signin?next=%2Faccount%3Fnext%3D%252Fplay%26email%3Dchanged%26error%3DTOKEN_EXPIRED",
  );
  assert.equal(accountSignInPath({ email: ["a", "b"] }), "/signin?next=%2Faccount");
  assert.equal(
    accountSignInPath({ next: "//evil.example" }),
    "/signin?next=%2Faccount%3Fnext%3D%252F%252Fevil.example",
  );
});

test("signing out on the account page leaves it for sign-in; elsewhere the page stays", () => {
  assert.equal(signOutDestination("/account"), "/signin?next=%2Faccount");
  for (const path of ["/rank", "/play", "/runs/abc", "/accounts", "/"])
    assert.equal(signOutDestination(path), null, path);
});
