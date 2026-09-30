import { db } from "./db";
import { MONITOR_MODEL, MONITOR_PROMPT, MONITOR_VERSION, GameError } from "./policy";
import type { Season } from "./types";

// Edit this roster before the next season starts. Published seasons keep their saved monitor.
export const MONITOR_ROTATION = [MONITOR_MODEL];
const EPOCH = Date.UTC(2026, 8, 28); // Monday, 00:00 UTC.
const WEEK = 7 * 24 * 60 * 60 * 1000;
export function weeklySeason(now = new Date(), models = MONITOR_ROTATION) {
  if (!models.length || models.some((model) => !model.trim()))
    throw new GameError("The season monitor roster is empty.", 503);
  const index = Math.floor((now.getTime() - EPOCH) / WEEK);
  const startsAt = new Date(EPOCH + index * WEEK).toISOString(),
    endsAt = new Date(EPOCH + (index + 1) * WEEK).toISOString();
  return {
    id: startsAt.slice(0, 10),
    name: `Week of ${startsAt.slice(0, 10)}`,
    startsAt,
    endsAt,
    monitorModel: models[((index % models.length) + models.length) % models.length],
  };
}
export async function currentSeason(): Promise<Season> {
  const week = weeklySeason();
  await db.query(
    `INSERT INTO ctf.seasons(id,name,starts_at,ends_at,monitor_model,monitor_version,monitor_prompt)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING`,
    [
      week.id,
      week.name,
      week.startsAt,
      week.endsAt,
      week.monitorModel,
      MONITOR_VERSION,
      MONITOR_PROMPT,
    ],
  );
  return (await listSeasons()).find((season) => season.id === week.id)!;
}
export async function listSeasons(): Promise<Season[]> {
  return (
    await db.query("SELECT * FROM ctf.seasons ORDER BY starts_at DESC NULLS LAST,id")
  ).rows.map((row) => ({
    id: row.id,
    name: row.name,
    startsAt: row.starts_at?.toISOString() ?? null,
    endsAt: row.ends_at?.toISOString() ?? null,
    monitorModel: row.monitor_model,
  }));
}
