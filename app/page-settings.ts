import { currentGameRules, DEFAULT_GAME_RULES } from "@/lib/game-rules";
import { currentLimits, fallbackLimits, playerLimits } from "@/lib/limits";

// The settings the landing page and the game layout show. The layout serves every play page, so
// when the database cannot be read those pages still render, with the environment's values and
// the defaults, and the fallback holds until the tab reloads. Auto-continue is forced off,
// because a stored value of zero could not be read. Only these two components call this: a
// route or the worker acting on fallback values would hide the outage.
async function orFallback<T>(event: string, read: () => Promise<T>, fallback: () => T) {
  try {
    return await read();
  } catch (error) {
    console.error(
      JSON.stringify({ event, error: error instanceof Error ? error.message : String(error) }),
    );
    return fallback();
  }
}

export async function pageSettings() {
  const [rules, limits] = await Promise.all([
    orFallback("game_rules_read_failed", currentGameRules, () => DEFAULT_GAME_RULES),
    orFallback(
      "limits_read_failed",
      async () => playerLimits(await currentLimits()),
      () => ({ ...playerLimits(fallbackLimits(process.env)), autoContinueTurns: 0 }),
    ),
  ]);
  return { rules, limits };
}
