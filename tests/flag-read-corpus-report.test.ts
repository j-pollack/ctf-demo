import assert from "node:assert/strict";
import { test } from "node:test";
import type { CorpusCase } from "../scripts/flag-read-corpus";
import {
  assignSplits,
  buildCorpusManifest,
  type AssignedCorpusCase,
  type PlayedArtifact,
} from "../scripts/flag-read-corpus-report";

function corpusCase(
  family: string,
  pair: string,
  kind: CorpusCase["kind"],
  overrides: Partial<CorpusCase> = {},
): CorpusCase {
  return {
    id: `${family}-${pair}-${kind}`,
    family,
    pair,
    kind,
    intent: "Focused report fixture.",
    targetSessionId: "target",
    readOccurred: kind === "attack",
    strict: kind === "attack" ? "read" : "no-read",
    presumption: kind === "attack" ? "read" : "no-read",
    hiddenSprites: {},
    sessions: [],
    ...overrides,
  };
}

function pair(family: string, pairId: string): CorpusCase[] {
  return [corpusCase(family, pairId, "attack"), corpusCase(family, pairId, "lookalike")];
}

function assigned(item: CorpusCase, split: "dev" | "test"): AssignedCorpusCase {
  return { ...item, split, labelProvenance: "execution" };
}

test("split assignment validates unique ids and complete attack/lookalike pairs", () => {
  const [attack, lookalike] = pair("alpha", "pair-a");
  assert.throws(() => assignSplits([attack, attack, lookalike]), /duplicate corpus case id/i);
  assert.throws(() => assignSplits([attack]), /exactly one attack.*one lookalike/i);
  assert.throws(
    () =>
      assignSplits([
        attack,
        corpusCase("alpha", "pair-a", "attack", { id: "second-attack" }),
        lookalike,
      ]),
    /exactly one attack.*one lookalike/i,
  );
  assert.equal(assignSplits([...pair("alpha", "shared"), ...pair("beta", "shared")]).length, 4);
});

test("split assignment is order-independent, non-mutating and rounds test pairs up", () => {
  const cases = [
    ...pair("alpha", "pair-d"),
    ...pair("beta", "pair-b"),
    ...pair("alpha", "pair-b"),
    ...pair("alpha", "pair-a"),
    ...pair("beta", "pair-a"),
    ...pair("alpha", "pair-c"),
  ];
  const snapshot = structuredClone(cases);
  const result = assignSplits(cases);
  const reversed = assignSplits([...cases].reverse());

  assert.deepEqual(result, reversed);
  assert.deepEqual(cases, snapshot);
  assert.ok(result.every((item, index) => item.id === [...result].map((x) => x.id).sort()[index]));
  assert.ok(result.every((item) => item.labelProvenance === "execution"));
  assert.ok(result.every((item, index) => item !== cases[index]));

  const testPairs = (family: string) =>
    result
      .filter((item) => item.family === family && item.split === "test")
      .map((item) => item.pair)
      .filter((pairId, index, all) => all.indexOf(pairId) === index)
      .sort();
  assert.deepEqual(testPairs("alpha"), ["pair-a", "pair-d"]);
  assert.deepEqual(testPairs("beta"), ["pair-b"]);
  assert.equal(result.filter((item) => item.family === "alpha" && item.split === "dev").length, 4);
  assert.equal(result.filter((item) => item.family === "beta" && item.split === "dev").length, 2);
});

test("manifest counts labels and family splits separately from the measured-read ceiling", () => {
  const cases = [
    assigned(
      corpusCase("alpha", "pair-a", "attack", {
        readOccurred: true,
        strict: "read",
        presumption: "read",
      }),
      "dev",
    ),
    assigned(corpusCase("alpha", "pair-a", "lookalike"), "dev"),
    assigned(
      corpusCase("alpha", "pair-b", "attack", {
        readOccurred: true,
        strict: "not-established",
        presumption: "read",
      }),
      "test",
    ),
    assigned(
      corpusCase("alpha", "pair-b", "lookalike", {
        readOccurred: false,
        strict: "not-established",
        presumption: "read",
      }),
      "test",
    ),
    assigned(
      corpusCase("beta", "pair-c", "attack", {
        readOccurred: true,
        strict: "no-read",
        presumption: "not-established",
      }),
      "test",
    ),
    assigned(corpusCase("beta", "pair-c", "lookalike"), "test"),
  ];
  const manifest = buildCorpusManifest(cases, []);

  assert.deepEqual(manifest.authored, { cases: 6, pairs: 3 });
  assert.deepEqual(manifest.counts.family, { alpha: 4, beta: 2 });
  assert.deepEqual(manifest.counts.kind, { attack: 3, lookalike: 3 });
  assert.deepEqual(manifest.counts.strict, { read: 1, "no-read": 3, "not-established": 2 });
  assert.deepEqual(manifest.counts.presumption, {
    read: 3,
    "no-read": 2,
    "not-established": 1,
  });
  assert.deepEqual(manifest.families, [
    {
      family: "alpha",
      cases: 4,
      pairs: 2,
      splits: { dev: 1, test: 1 },
      kind: { attack: 2, lookalike: 2 },
      strict: { read: 1, "no-read": 1, "not-established": 2 },
      presumption: { read: 3, "no-read": 1, "not-established": 0 },
    },
    {
      family: "beta",
      cases: 2,
      pairs: 1,
      splits: { dev: 0, test: 1 },
      kind: { attack: 1, lookalike: 1 },
      strict: { read: 0, "no-read": 2, "not-established": 0 },
      presumption: { read: 0, "no-read": 1, "not-established": 1 },
    },
  ]);
  assert.deepEqual(manifest.measuredReads, {
    total: 3,
    strict: { read: 1, "no-read": 1, "not-established": 1 },
    presumption: { read: 2, "no-read": 0, "not-established": 1 },
  });
  assert.deepEqual(manifest.recallCeiling, { strict: 1 / 3, presumption: 2 / 3 });
});

test("manifest preserves played artifact checks and marks only their labels as user-asserted", () => {
  const played: PlayedArtifact[] = [
    {
      part: "obvious-attack",
      gameId: "91352865",
      path: ".artifacts/flag-read-corpus/played/91352865.json",
      sessions: 4,
      mechanicalCheck: { flagInToolOutput: true },
    },
    {
      part: "clean",
      gameId: "89F20714",
      path: ".artifacts/flag-read-corpus/played/89F20714.json",
      sessions: 5,
      mechanicalCheck: { flagPathReferences: 0, tmpSweeps: 0 },
    },
  ];
  const snapshot = structuredClone(played);
  const manifest = buildCorpusManifest([], played);

  assert.deepEqual(played, snapshot);
  assert.deepEqual(manifest.played, [
    { ...played[1], labelProvenance: "user-asserted" },
    { ...played[0], labelProvenance: "user-asserted" },
  ]);
  assert.notEqual(manifest.played[0].mechanicalCheck, played[1].mechanicalCheck);
});

test("empty inputs produce explicit zero counts and null recall ceilings", () => {
  assert.deepEqual(assignSplits([]), []);
  assert.deepEqual(buildCorpusManifest([], []), {
    authored: { cases: 0, pairs: 0 },
    counts: {
      family: {},
      kind: { attack: 0, lookalike: 0 },
      strict: { read: 0, "no-read": 0, "not-established": 0 },
      presumption: { read: 0, "no-read": 0, "not-established": 0 },
    },
    families: [],
    measuredReads: {
      total: 0,
      strict: { read: 0, "no-read": 0, "not-established": 0 },
      presumption: { read: 0, "no-read": 0, "not-established": 0 },
    },
    recallCeiling: { strict: null, presumption: null },
    played: [],
  });
});
