import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  DISPLAY_NAME_QUESTIONS,
  NAME_REFUSAL_THRESHOLD,
  nameScores,
  nameVerdict,
  parseDisplayName,
} from "../lib/display-name";
import { DISPLAY_NAME_PATTERN, DISPLAY_NAME_RULE } from "../lib/display-name-rule";
import type { TypesafeAnswer } from "../lib/typesafe";

test("U1: a display name is 3 to 24 ASCII letters, digits, hyphens or underscores, trimmed", () => {
  for (const name of ["abc", "a".repeat(24), "Zed_99", "-dash-", "__", "Mixed-Case_1"].filter(
    (value) => value.length >= 3,
  ))
    assert.equal(parseDisplayName(name), name);
  assert.equal(parseDisplayName("  padded-name \t"), "padded-name");
  for (const bad of [
    "ab",
    "a".repeat(25),
    "two words",
    "dot.name",
    "at@name",
    "emoji🙂",
    "café",
    "ｆｕｌｌ",
    "tab\tname",
    "",
    "   ",
    "<b>x</b>",
  ])
    assert.throws(
      () => parseDisplayName(bad),
      { message: DISPLAY_NAME_RULE, status: 400 },
      JSON.stringify(bad),
    );
  for (const bad of [undefined, null, 42, ["abc"], { name: "abc" }])
    assert.throws(() => parseDisplayName(bad), { message: DISPLAY_NAME_RULE, status: 400 });
});

const answers = (scores: Record<string, number>): Record<string, TypesafeAnswer> =>
  Object.fromEntries(
    Object.keys(DISPLAY_NAME_QUESTIONS).map((name) => [
      name,
      { type: "noul", noul: scores[name] ?? 0.05 },
    ]),
  );

test("U1: the browser's pattern compiles under the v flag and agrees with the server", () => {
  // Browsers compile an input's pattern as ^(?:pattern)$ with the v flag and ignore it if that throws.
  const browser = new RegExp(`^(?:${DISPLAY_NAME_PATTERN})$`, "v");
  for (const value of ["abc", "a-b_c", "A".repeat(24)]) assert.ok(browser.test(value), value);
  for (const value of ["ab", "a b", "a.b", "a".repeat(25), "café"])
    assert.ok(!browser.test(value), value);
});

test("U1: the client-safe rule module imports nothing", () => {
  const source = readFileSync(new URL("../lib/display-name-rule.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /^\s*import\b/m);
});

test("U2: the name is refused when any question is at or above 0.6", () => {
  assert.equal(NAME_REFUSAL_THRESHOLD, 0.6);
  assert.deepEqual(Object.keys(DISPLAY_NAME_QUESTIONS), ["offensive", "sexual", "impersonates"]);
  for (const question of Object.values(DISPLAY_NAME_QUESTIONS)) {
    assert.equal(question.type, "noul");
    assert.match(question.instructions, /^`name` is a display name a player chose/);
  }
  assert.equal(nameVerdict(nameScores(answers({}))), "allowed");
  assert.deepEqual(nameScores(answers({ sexual: 0.7 })), {
    offensive: 0.05,
    sexual: 0.7,
    impersonates: 0.05,
  });
  // Measured on real Jev: an ordinary handle scored 0.54 and the closest rude one 0.66.
  assert.equal(nameVerdict(nameScores(answers({ sexual: 0.54 }))), "allowed");
  assert.equal(nameVerdict(nameScores(answers({ offensive: 0.59 }))), "allowed");
  for (const question of Object.keys(DISPLAY_NAME_QUESTIONS)) {
    assert.equal(nameVerdict(nameScores(answers({ [question]: 0.6 }))), "refused", question);
    assert.equal(nameVerdict(nameScores(answers({ [question]: 0.66 }))), "refused", question);
    assert.equal(nameVerdict(nameScores(answers({ [question]: 0.97 }))), "refused", question);
  }
});

test("U2: a missing or non-Noul answer is not a verdict", () => {
  const { sexual: _dropped, ...partial } = answers({});
  assert.throws(() => nameScores(partial), /no usable answer for "sexual"/);
  assert.throws(
    () =>
      nameScores({
        ...answers({}),
        offensive: { type: "score", score: 0, confidence: 1 },
      }),
    /no usable answer for "offensive"/,
  );
});
