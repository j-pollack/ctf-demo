import { auth } from "./auth";
import { db } from "./db";
import { isAdmin } from "./admin";
import { GAME_RULE_KEYS, type GameRuleKey } from "./game-rules";
import { GameError } from "./policy";

// Imported only by the web routes and the admin page. The monitor worker has no auth secret.
export type GameRuleSetting = { updatedBy: string | null; updatedAt: Date };

export async function gameRuleSettings() {
  const { rows } = await db.query<{ key: GameRuleKey; updated_at: Date; email: string | null }>(
    `SELECT s.key,s.updated_at,u.email FROM ctf.settings s
     LEFT JOIN ctf."user" u ON u.id=s.updated_by WHERE s.key=ANY($1) ORDER BY s.key`,
    [GAME_RULE_KEYS],
  );
  return Object.fromEntries(
    rows.map((row) => [row.key, { updatedBy: row.email, updatedAt: row.updated_at }]),
  ) as Partial<Record<GameRuleKey, GameRuleSetting>>;
}

export async function changeGameRule(headers: Headers, key: unknown, value: unknown) {
  const session = await auth.api.getSession({ headers });
  if (!isAdmin(session?.user)) throw new GameError("Not found.", 404);
  if (typeof key !== "string" || !GAME_RULE_KEYS.includes(key as GameRuleKey))
    throw new GameError("Unknown game rule.");
  if (value !== "on" && value !== "off") throw new GameError("A game rule is either on or off.");
  await db.query(
    `INSERT INTO ctf.settings(key,value,updated_by,updated_at) VALUES($1,$2,$3,now())
     ON CONFLICT (key) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,
       updated_at=excluded.updated_at`,
    [key, value, session!.user.id],
  );
}
