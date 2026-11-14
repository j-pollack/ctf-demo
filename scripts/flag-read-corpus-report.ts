import { createHash } from "node:crypto";
import type { CorpusCase } from "./flag-read-corpus";

export type CorpusSplit = "dev" | "test";
export type AssignedCorpusCase = CorpusCase & {
  split: CorpusSplit;
  labelProvenance: "execution";
};
export type PlayedArtifact = {
  part: "clean" | "obvious-attack";
  gameId: string;
  path: string;
  sessions: number;
  mechanicalCheck: Readonly<Record<string, boolean | number>>;
};
export type PlayedManifestEntry = PlayedArtifact & { labelProvenance: "user-asserted" };
type Standard = "strict" | "presumption";
type Verdict = CorpusCase["strict"];
type VerdictCounts = Record<Verdict, number>;
type KindCounts = Record<CorpusCase["kind"], number>;
export type CorpusManifest = {
  authored: { cases: number; pairs: number };
  counts: {
    family: Record<string, number>;
    kind: KindCounts;
    strict: VerdictCounts;
    presumption: VerdictCounts;
  };
  families: {
    family: string;
    cases: number;
    pairs: number;
    splits: Record<CorpusSplit, number>;
    kind: KindCounts;
    strict: VerdictCounts;
    presumption: VerdictCounts;
  }[];
  measuredReads: {
    total: number;
    strict: VerdictCounts;
    presumption: VerdictCounts;
  };
  recallCeiling: Record<Standard, number | null>;
  played: PlayedManifestEntry[];
};

function lexical(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function pairKey(family: string, pair: string): string {
  return JSON.stringify([family, pair]);
}

function pairHash(family: string, pair: string): string {
  // Separate the tuple members so different family/pair boundaries cannot share an input string.
  return createHash("sha256").update(family).update("\0").update(pair).digest("hex");
}

export function assignSplits(cases: readonly CorpusCase[]): AssignedCorpusCase[] {
  const ids = new Set<string>();
  const groups = new Map<string, { family: string; pair: string; cases: CorpusCase[] }>();
  for (const item of cases) {
    if (ids.has(item.id)) throw new Error(`Duplicate corpus case id ${item.id}.`);
    ids.add(item.id);
    const key = pairKey(item.family, item.pair);
    const group = groups.get(key) ?? { family: item.family, pair: item.pair, cases: [] };
    group.cases.push(item);
    groups.set(key, group);
  }

  const ordered = [...groups.values()].map((group) => {
    const attacks = group.cases.filter((item) => item.kind === "attack").length;
    const lookalikes = group.cases.filter((item) => item.kind === "lookalike").length;
    if (group.cases.length !== 2 || attacks !== 1 || lookalikes !== 1)
      throw new Error(
        `${group.family}/${group.pair}: expected exactly one attack and one lookalike.`,
      );
    return { ...group, hash: pairHash(group.family, group.pair) };
  });
  ordered.sort(
    (a, b) => lexical(a.hash, b.hash) || lexical(a.family, b.family) || lexical(a.pair, b.pair),
  );

  const totals = new Map<string, number>();
  for (const group of ordered) totals.set(group.family, (totals.get(group.family) ?? 0) + 1);
  const selected = new Map<string, number>();
  const assigned = ordered.flatMap((group) => {
    const used = selected.get(group.family) ?? 0;
    const split: CorpusSplit =
      used < Math.ceil((totals.get(group.family) ?? 0) / 3) ? "test" : "dev";
    selected.set(group.family, used + 1);
    return group.cases.map((item) => ({ ...item, split, labelProvenance: "execution" as const }));
  });
  return assigned.sort((a, b) => lexical(a.id, b.id));
}

function emptyVerdictCounts(): VerdictCounts {
  return { read: 0, "no-read": 0, "not-established": 0 };
}

function labelCounts(cases: readonly CorpusCase[]) {
  const kind: KindCounts = { attack: 0, lookalike: 0 };
  const strict = emptyVerdictCounts();
  const presumption = emptyVerdictCounts();
  for (const item of cases) {
    kind[item.kind] += 1;
    strict[item.strict] += 1;
    presumption[item.presumption] += 1;
  }
  return { kind, strict, presumption };
}

export function buildCorpusManifest(
  cases: readonly AssignedCorpusCase[],
  played: readonly PlayedArtifact[],
): CorpusManifest {
  const familyNames = [...new Set(cases.map((item) => item.family))].sort(lexical);
  const families = familyNames.map((family) => {
    const members = cases.filter((item) => item.family === family);
    const pairSplits = new Map<string, CorpusSplit>();
    for (const item of members) {
      const previous = pairSplits.get(item.pair);
      if (previous && previous !== item.split)
        throw new Error(`${family}/${item.pair}: conflicting split assignments.`);
      pairSplits.set(item.pair, item.split);
    }
    return {
      family,
      cases: members.length,
      pairs: pairSplits.size,
      splits: {
        dev: [...pairSplits.values()].filter((split) => split === "dev").length,
        test: [...pairSplits.values()].filter((split) => split === "test").length,
      },
      ...labelCounts(members),
    };
  });
  const measured = cases.filter((item) => item.readOccurred);
  const measuredLabels = labelCounts(measured);
  const recallCeiling = (standard: Standard) =>
    measured.length === 0 ? null : measuredLabels[standard].read / measured.length;

  return {
    authored: {
      cases: cases.length,
      pairs: new Set(cases.map((item) => pairKey(item.family, item.pair))).size,
    },
    counts: {
      family: Object.fromEntries(families.map((family) => [family.family, family.cases])),
      ...labelCounts(cases),
    },
    families,
    measuredReads: {
      total: measured.length,
      strict: measuredLabels.strict,
      presumption: measuredLabels.presumption,
    },
    recallCeiling: { strict: recallCeiling("strict"), presumption: recallCeiling("presumption") },
    played: played
      .map((item) => ({
        ...item,
        mechanicalCheck: { ...item.mechanicalCheck },
        labelProvenance: "user-asserted" as const,
      }))
      .sort(
        (a, b) => lexical(a.part, b.part) || lexical(a.gameId, b.gameId) || lexical(a.path, b.path),
      ),
  };
}
