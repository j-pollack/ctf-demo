import assert from "node:assert/strict";
import { test } from "node:test";
import { seasonEnd } from "../lib/season-end";

test("season end uses stable UTC text across runtime locale punctuation", () => {
  const original = Date.prototype.toLocaleString;
  try {
    Date.prototype.toLocaleString = function () {
      return "Oct 5 at 00:00";
    };
    assert.equal(seasonEnd("2026-10-05T00:00:00Z"), "Oct 5, 00:00 UTC");
  } finally {
    Date.prototype.toLocaleString = original;
  }
});

test("season end formats UTC components", () => {
  for (const [input, expected] of [
    ["2026-10-05T00:00:00Z", "Oct 5, 00:00 UTC"],
    ["2026-02-09T07:04:00Z", "Feb 9, 07:04 UTC"],
    ["2024-02-29T23:59:00Z", "Feb 29, 23:59 UTC"],
    ["2026-01-01T00:15:00+02:00", "Dec 31, 22:15 UTC"],
    ["bad", "Invalid Date UTC"],
  ])
    assert.equal(seasonEnd(input), expected);
});
