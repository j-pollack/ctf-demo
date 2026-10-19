import { db } from "./db";
import { getModel } from "./inference";
import { GameError, MODELS } from "./policy";
import { currentSeason } from "./seasons";

// Admin is a database flag on the user; guests never qualify.
export function isAdmin(
  user: { isAdmin?: boolean | null; isAnonymous?: boolean | null } | undefined,
) {
  return user?.isAdmin === true && !user.isAnonymous;
}

// A fork inherits its parent's spend, turns and blocks, so those sums skip any run that has a fork.
const LEAF = "NOT EXISTS(SELECT 1 FROM ctf.games c WHERE c.forked_from=g.id)";
// All buckets are UTC. Money is microdollars; bigint sums are cast to float8 so pg returns numbers.
export async function adminStats() {
  const [totals, daily, monthly, outcomes, models, seasons, spenders] = await Promise.all([
    db.query(`SELECT
      (SELECT count(*) FROM ctf."user" WHERE "isAnonymous" IS NOT TRUE)::int AS members,
      (SELECT count(*) FROM ctf."user" WHERE "isAnonymous" IS TRUE)::int AS guests,
      count(*)::int AS runs,
      count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS runs_7d,
      count(*) FILTER (WHERE status='captured')::int AS captures,
      count(*) FILTER (WHERE status IN ('creating','active'))::int AS open_runs,
      count(DISTINCT owner_id)::int AS players,
      coalesce(sum(spent_microdollars) FILTER (WHERE ${LEAF}),0)::float8 AS spend,
      coalesce(sum(reserved_microdollars) FILTER (WHERE ${LEAF}),0)::float8 AS reserved,
      coalesce(avg(spent_microdollars) FILTER (WHERE ${LEAF}),0)::float8 AS spend_avg,
      coalesce(percentile_cont(0.5) WITHIN GROUP (ORDER BY spent_microdollars) FILTER (WHERE ${LEAF}),0)::float8 AS spend_p50,
      coalesce(percentile_cont(0.9) WITHIN GROUP (ORDER BY spent_microdollars) FILTER (WHERE ${LEAF}),0)::float8 AS spend_p90,
      coalesce(max(spent_microdollars) FILTER (WHERE ${LEAF}),0)::float8 AS spend_max,
      coalesce(avg(spent_microdollars) FILTER (WHERE status='captured'),0)::float8 AS spend_per_capture,
      coalesce(avg(turns) FILTER (WHERE ${LEAF}),0)::float8 AS turns_avg,
      coalesce(sum(turns) FILTER (WHERE ${LEAF}),0)::int AS turns,
      coalesce(sum(blocks) FILTER (WHERE ${LEAF}),0)::int AS blocks,
      (SELECT count(*) FROM ctf.inference WHERE estimated)::int AS estimated_settlements
      FROM ctf.games g`),
    db.query(`SELECT to_char(d,'YYYY-MM-DD') AS day,
      (SELECT count(*) FROM ctf.games g WHERE g.created_at>=d AND g.created_at<d+interval '1 day')::int AS runs,
      (SELECT count(*) FROM ctf.games g WHERE g.created_at>=d AND g.created_at<d+interval '1 day' AND g.status='captured')::int AS captures,
      (SELECT count(DISTINCT owner_id) FROM ctf.games g WHERE g.created_at>=d AND g.created_at<d+interval '1 day')::int AS players,
      coalesce((SELECT charged FROM ctf.daily_spend s WHERE s.day=d::date),0)::float8 AS spend
      FROM generate_series(date_trunc('day', now() AT TIME ZONE 'UTC') - interval '29 days',
        date_trunc('day', now() AT TIME ZONE 'UTC'), interval '1 day') d
      ORDER BY d`),
    db.query(`SELECT to_char(date_trunc('month',"createdAt" AT TIME ZONE 'UTC'),'YYYY-MM') AS month,
      count(*) FILTER (WHERE "isAnonymous" IS NOT TRUE)::int AS members,
      count(*) FILTER (WHERE "isAnonymous" IS TRUE)::int AS guests
      FROM ctf."user" GROUP BY 1 ORDER BY 1 DESC LIMIT 12`),
    db.query(`SELECT status,count(*)::int AS runs,coalesce(sum(spent_microdollars) FILTER (WHERE ${LEAF}),0)::float8 AS spend
      FROM ctf.games g GROUP BY status ORDER BY runs DESC`),
    db.query(`SELECT role,model,count(*)::int AS calls,coalesce(sum(tokens),0)::float8 AS tokens,
      coalesce(sum(cost),0)::float8 AS spend,count(*) FILTER (WHERE settled_at IS NULL)::int AS pending
      FROM ctf.inference GROUP BY role,model ORDER BY spend DESC`),
    db.query(`SELECT s.id,s.name,s.monitor_model,count(g.id)::int AS runs,
      count(g.id) FILTER (WHERE g.status='captured')::int AS captures,
      coalesce(sum(g.spent_microdollars) FILTER (WHERE ${LEAF}),0)::float8 AS spend
      FROM ctf.seasons s LEFT JOIN ctf.games g ON g.season_id=s.id
      GROUP BY s.id ORDER BY max(g.created_at) DESC NULLS LAST LIMIT 12`),
    db.query(`SELECT coalesce(u.email,g.owner_id) AS who,u."isAnonymous" AS guest,count(*)::int AS runs,
      count(*) FILTER (WHERE g.status='captured')::int AS captures,
      sum(g.spent_microdollars) FILTER (WHERE ${LEAF})::float8 AS spend
      FROM ctf.games g LEFT JOIN ctf."user" u ON u.id=g.owner_id
      GROUP BY 1,2 ORDER BY spend DESC LIMIT 10`),
  ]);
  return {
    totals: totals.rows[0],
    daily: daily.rows,
    monthly: monthly.rows,
    outcomes: outcomes.rows,
    models: models.rows,
    seasons: seasons.rows,
    spenders: spenders.rows,
  };
}

// Swaps this week's monitor in place: new runs use it, started runs keep the one they copied.
export async function setSeasonMonitor(model: string) {
  if (!MODELS.includes(model)) throw new GameError("Unsupported monitor model.");
  await getModel(model, "monitor"); // OpenRouter must offer it with JSON responses.
  const season = await currentSeason();
  await db.query("UPDATE ctf.seasons SET monitor_model=$1 WHERE id=$2", [model, season.id]);
}
