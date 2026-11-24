import assert from "node:assert/strict";
import { test } from "node:test";
import { createDecodedScreen } from "../lib/decode-screen";

test("S-f: a decoded layer is never screened without a review claim", async () => {
  const screen = createDecodedScreen({
    game: { id: "g", execution_generation: 0, jailbreak_catch: true } as never,
    claim: undefined,
    reviewId: "r",
    signal: new AbortController().signal,
    fail: () => assert.fail("a missing claim is not a review failure"),
  });
  await assert.rejects(screen(["text"]), /without a review claim/);
});
