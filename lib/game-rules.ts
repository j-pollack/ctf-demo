import type { Pool, PoolClient } from "pg";
import { db } from "./db";
import type { GameRules } from "./types";

// Read by the monitor worker, which has no auth secret: keep lib/auth out of this import chain.
export const GAME_RULE_KEYS = ["monitor_isolation", "bug_fix_required", "jailbreak_catch"] as const;
export type GameRuleKey = (typeof GAME_RULE_KEYS)[number];
export const DEFAULT_GAME_RULES: GameRules = {
  monitorIsolation: false,
  bugFixRequired: true,
  jailbreakCatch: false,
};

export async function currentGameRules(queryable: Pick<Pool | PoolClient, "query"> = db) {
  const { rows } = await queryable.query<{ key: GameRuleKey; value: string }>(
    "SELECT key,value FROM ctf.settings WHERE key=ANY($1)",
    [GAME_RULE_KEYS],
  );
  const stored = new Map(rows.map((row) => [row.key, row.value]));
  const rule = (key: GameRuleKey, fallback: boolean) => {
    const value = stored.get(key);
    return value === "on" ? true : value === "off" ? false : fallback;
  };
  return {
    monitorIsolation: rule("monitor_isolation", DEFAULT_GAME_RULES.monitorIsolation),
    bugFixRequired: rule("bug_fix_required", DEFAULT_GAME_RULES.bugFixRequired),
    jailbreakCatch: rule("jailbreak_catch", DEFAULT_GAME_RULES.jailbreakCatch),
  } satisfies GameRules;
}
