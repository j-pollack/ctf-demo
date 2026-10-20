import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db } from "../lib/db";
import {
  claimGame,
  getGame,
  publicGame,
  reconcileInference,
  reserveInference,
  settleInference,
  transaction,
} from "../lib/games";
import { AGENT_MODEL, makeSecret, MODELS, MONITOR_MODEL, MONITOR_VERSION } from "../lib/policy";

const id = randomUUID(),
  owner = `budget-check-${id}`;
const originalFetch = globalThis.fetch;
try {
  await db.query(
    `INSERT INTO ctf.games(id,owner_id,sprite_name,secret_hash,agent_model,monitor_model,monitor_version,token_budget,status,sprite_deleted_at)
    VALUES($1,$2,$2,$3,$4,$5,$6,100000,'active',now())`,
    [id, owner, makeSecret().hash, AGENT_MODEL, MONITOR_MODEL, MONITOR_VERSION],
  );
  const game = await claimGame(id, owner);
  const attempted = await Promise.allSettled(
    Array.from({ length: 8 }, () =>
      reserveInference(id, game.lease, "agent", game.agent_model, 1000, 1000, 0.0001),
    ),
  );
  const accepted = attempted
    .filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof reserveInference>>> =>
        result.status === "fulfilled",
    )
    .map((result) => result.value);
  assert.equal(accepted.length, 2, "only two $0.30 holds fit a $0.60 run");
  assert.equal(Number((await getGame(id, owner)).reserved_microdollars), 600000);
  await settleInference(accepted[0].id, { tokens: 10, cost: 0.02, generationId: `test-${id}` });
  await settleInference(accepted[0].id, { tokens: 100, cost: 0.99 });
  await settleInference(accepted[1].id);
  let ui = await publicGame(await getGame(id, owner));
  assert.equal(ui.spentMicrodollars, 20000, "verified charges must settle exactly once");
  assert.equal(ui.agentSpendMicrodollars, 20000);
  assert.equal(ui.reservedMicrodollars, 300000, "unknown billing remains a hold");
  await db.query(
    "UPDATE ctf.inference SET generation_id=$2,created_at=now()-interval '3 minutes' WHERE id=$1",
    [accepted[1].id, `test-reconcile-${id}`],
  );
  let finished = false;
  globalThis.fetch = async (input, options) =>
    String(input).includes(`id=test-reconcile-${id}`)
      ? Response.json({
          data: {
            finish_reason: finished ? "stop" : null,
            total_cost: 0,
            native_tokens_prompt: 0,
            native_tokens_completion: 0,
          },
        })
      : originalFetch(input, options);
  await reconcileInference();
  assert.equal(
    Number((await getGame(id, owner)).reserved_microdollars),
    300000,
    "incomplete provider metadata must not release a hold",
  );
  finished = true;
  await db.query("UPDATE ctf.inference SET reconciliation_attempted_at=NULL WHERE id=$1", [
    accepted[1].id,
  ]);
  await reconcileInference();
  ui = await publicGame(await getGame(id, owner));
  assert.equal(ui.reservedMicrodollars, 0, "an unbilled rejection refunds the complete hold");
  assert.equal(ui.spentMicrodollars, 20000);
  await db.query("UPDATE ctf.games SET lease=NULL,lease_until=NULL WHERE id=$1", [id]);
  const switched = await claimGame(
    id,
    owner,
    MODELS.find((model) => model !== AGENT_MODEL),
  );
  assert.equal(switched.monitor_model, MONITOR_MODEL);
  await assert.rejects(() => claimGame(id, owner, AGENT_MODEL), /already/);
  console.log("Concurrent dollar admission, actual spend, pending holds and refunds passed.");
} finally {
  globalThis.fetch = originalFetch;
  // These are synthetic billing records in a test-only game: undo their cap impact.
  await transaction(async (client) => {
    const calls = (
      await client.query(
        "SELECT day,sum(coalesce(cost,0)) AS charged,sum(cost_ceiling) FILTER(WHERE settled_at IS NULL) AS reserved FROM ctf.inference WHERE game_id=$1 GROUP BY day",
        [id],
      )
    ).rows;
    for (const call of calls)
      await client.query(
        "UPDATE ctf.daily_spend SET charged=charged-$2,reserved=reserved-$3 WHERE day=$1",
        [call.day, call.charged, call.reserved ?? 0],
      );
    await client.query("DELETE FROM ctf.inference WHERE game_id=$1", [id]);
    await client.query("DELETE FROM ctf.games WHERE id=$1", [id]);
  });
  await db.end();
}
