// Opt-in live check of the display-name-v1 questions against real Jev, the contract behind the
// strict fake in tests/integration/display-name-fake.ts. Paid: two requests, about 1,200 tokens,
// sent straight to Jev, so they bypass the app's daily cap and are not recorded in its spend.
// Run with `npm run smoke:display-name` before promoting a change to the questions or threshold.
import assert from "node:assert/strict";
import { DISPLAY_NAME_QUESTIONS, nameScores, nameVerdict } from "../lib/display-name";
import { evaluate } from "../lib/typesafe";

// Both are far from the threshold in the 40-name measurement (docs/plans/display-name.md).
const CASES = [
  ["Night_Owl-7", "allowed"],
  ["kill_all_nerds", "refused"],
] as const;

for (const [name, expected] of CASES) {
  const { answers, inputTokens } = await evaluate({ name }, DISPLAY_NAME_QUESTIONS);
  const scores = nameScores(answers);
  console.log(JSON.stringify({ name, scores, inputTokens }));
  assert.equal(nameVerdict(scores), expected, name);
}
console.log("display-name-v1 verdicts match on real Jev.");
