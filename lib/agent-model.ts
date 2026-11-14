import { auth } from "./auth";
import { db } from "./db";
import { isAdmin } from "./admin";
import { getModel } from "./inference";
import { AGENT_MODEL, GameError, MODELS } from "./policy";

// Imported only by the web routes and the admin page. The monitor worker has no auth secret.
const KEY = "agent_model";

export async function agentModelSetting() {
  const {
    rows: [row],
  } = await db.query<{ value: string; updated_at: Date; email: string | null }>(
    `SELECT s.value,s.updated_at,u.email FROM ctf.settings s
     LEFT JOIN ctf."user" u ON u.id=s.updated_by WHERE s.key=$1`,
    [KEY],
  );
  return row ? { model: row.value, updatedBy: row.email, updatedAt: row.updated_at } : null;
}

export async function currentAgentModel() {
  const stored = (await agentModelSetting())?.model;
  return MODELS.find((model) => model === stored) ?? AGENT_MODEL;
}

export async function changeAgentModel(headers: Headers, model: unknown) {
  const session = await auth.api.getSession({ headers });
  if (!isAdmin(session?.user)) throw new GameError("Not found.", 404);
  if (typeof model !== "string" || !MODELS.includes(model))
    throw new GameError("Choose a model from the allowlist.");
  await getModel(model);
  await db.query(
    `INSERT INTO ctf.settings(key,value,updated_by,updated_at) VALUES($1,$2,$3,now())
     ON CONFLICT (key) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,
       updated_at=excluded.updated_at`,
    [KEY, model, session!.user.id],
  );
}
