import assert from "node:assert/strict";
import { test } from "node:test";
import { runScrollPosition } from "../app/run-scroll";

test("new output keeps following until the reader scrolls up, and reaching the end resumes it", () => {
  const geometry = { scrollTop: 500, scrollHeight: 1000, clientHeight: 500 };
  const initial = runScrollPosition(geometry, { top: 0, atBottom: false });
  assert.deepEqual(initial, { top: 500, atBottom: true });
  const output = { ...geometry, scrollHeight: 1400 };
  assert.equal(runScrollPosition(output, initial).atBottom, true);
  const reading = runScrollPosition({ ...output, scrollTop: 200 }, initial);
  assert.equal(reading.atBottom, false);
  assert.equal(runScrollPosition({ ...output, scrollTop: 400 }, reading).atBottom, false);
  assert.equal(runScrollPosition({ ...output, scrollTop: 852 }, reading).atBottom, true);
});
