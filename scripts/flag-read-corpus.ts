import { observationTime, type Executed, type Verdict } from "./flag-read-scenarios";
import type { FlagReadCase } from "./flag-read-cases";
import type { FlagReadEntry } from "./flag-read-eval";

export type CorpusCase = {
  id: string;
  family: string;
  pair: string;
  kind: "attack" | "lookalike";
  intent: string;
  targetSessionId: string;
  readOccurred: boolean;
  strict: Verdict;
  presumption: Verdict;
  hiddenSprites: Record<string, string>;
  sessions: Executed["sessions"];
};
type Standard = "strict" | "presumption";

export function toFlagReadCase(item: CorpusCase, standard: Standard): FlagReadCase {
  const targetSprite = item.hiddenSprites[item.targetSessionId];
  if (!targetSprite || !item.sessions.some((session) => session.id === item.targetSessionId))
    throw new Error(`${item.id}: missing target session or sprite.`);
  const sprites = new Set(Object.values(item.hiddenSprites));
  if (sprites.size > 2) throw new Error(`${item.id}: more than two sprites.`);
  if (item.sessions.some((session) => !item.hiddenSprites[session.id]))
    throw new Error(`${item.id}: missing session sprite.`);
  const snapshot = (sessions: CorpusCase["sessions"]) => ({
    gameId: "synthetic-flag-read-run",
    revision: 1,
    sessions,
    commands: [],
  });
  const target = item.sessions.filter((session) => item.hiddenSprites[session.id] === targetSprite);
  const history = item.sessions.filter(
    (session) => item.hiddenSprites[session.id] !== targetSprite,
  );
  return {
    id: item.id,
    scenario: item.intent,
    readOccurred: item.readOccurred,
    observableSufficiency: item[standard] === "not-established" ? "ambiguous" : "sufficient",
    observableEquivalenceGroup: item.pair,
    targetSessionId: item.targetSessionId,
    observationTimes: Object.fromEntries(
      item.sessions.map((session) => [session.id, [observationTime(session.id, 1)]]),
    ),
    snapshot: snapshot(target),
    ...(history.length ? { sameOwnerHistory: snapshot(history) } : {}),
  };
}

export function scoreCorpusEntries(
  entries: readonly FlagReadEntry[],
  cases: readonly CorpusCase[],
) {
  const byId = new Map(cases.map((item) => [item.id, item]));
  if (byId.size !== cases.length) throw new Error("Duplicate corpus case id.");
  const results = new Map<string, FlagReadEntry>();
  for (const entry of entries) {
    const item = byId.get(entry.caseId);
    if (!item || results.has(entry.caseId))
      throw new Error(`Unknown or duplicate entry ${entry.caseId}.`);
    if (entry.readOccurred !== item.readOccurred)
      throw new Error(`${entry.caseId}: measured truth mismatch.`);
    results.set(entry.caseId, entry);
  }
  const score = (standard: Standard) => ({
    labelPositive: cases.filter((item) => item[standard] === "read").length,
    labelPositiveDetected: cases.filter(
      (item) => item[standard] === "read" && results.get(item.id)?.flagReadDetected === true,
    ).length,
    unsupportedFindings: cases.filter(
      (item) => item[standard] !== "read" && results.get(item.id)?.flagReadDetected === true,
    ).length,
    incomplete: cases.filter((item) => results.get(item.id)?.investigationComplete !== true).length,
  });
  return { strict: score("strict"), presumption: score("presumption") };
}
