import { auth } from "./auth";
import { db } from "./db";
import { isAdmin } from "./admin";
import { LIMIT_KEYS, parseLimitInput, type LimitKey } from "./limits";
import { GameError } from "./policy";

// Imported only by the web routes and the admin page. The monitor worker has no auth secret.
export type LimitSetting = { updatedBy: string | null; updatedAt: Date };

export async function limitSettings() {
  const { rows } = await db.query<{ key: LimitKey; updated_at: Date; email: string | null }>(
    `SELECT s.key,s.updated_at,u.email FROM ctf.settings s
     LEFT JOIN ctf."user" u ON u.id=s.updated_by WHERE s.key=ANY($1) ORDER BY s.key`,
    [LIMIT_KEYS],
  );
  return Object.fromEntries(
    rows.map((row) => [row.key, { updatedBy: row.email, updatedAt: row.updated_at }]),
  ) as Partial<Record<LimitKey, LimitSetting>>;
}

export async function changeLimit(headers: Headers, key: unknown, value: unknown) {
  const session = await auth.api.getSession({ headers });
  if (!isAdmin(session?.user)) throw new GameError("Not found.", 404);
  if (typeof key !== "string" || !LIMIT_KEYS.some((known) => known === key))
    throw new GameError("Unknown limit.");
  const parsed = parseLimitInput(key, value);
  if (parsed === null) throw new GameError("Enter a value the limit allows.");
  await db.query(
    `INSERT INTO ctf.settings(key,value,updated_by,updated_at) VALUES($1,$2,$3,now())
     ON CONFLICT (key) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,
       updated_at=excluded.updated_at`,
    [key, String(parsed), session!.user.id],
  );
}
