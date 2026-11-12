import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { resolveFlagReadPolicy } from "../../lib/flag-read-policy";
import { runFlagReadLiveEvaluation } from "../../scripts/flag-read-eval-live";
import { heldoutFlagReadCases } from "../../scripts/flag-read-heldout-cases";

const baseUrl = new URL(process.env.CTF_INTEGRATION_DATABASE_URL ?? "http://missing");
assert.equal(process.env.NODE_ENV, "test", "Use npm run test:integration");
assert.equal(baseUrl.hostname, "127.0.0.1");
assert.match(baseUrl.pathname, /^\/ctf_integration_[a-f0-9]{32}$/);

for (const searchStrategy of ["focused", "provenance"] as const)
  test(`budget-skipped cases retain the ${searchStrategy} policy without dispatch`, async (t) => {
    const databaseName = `ctf_integration_${randomUUID().replaceAll("-", "")}`;
    const adminUrl = new URL(baseUrl);
    adminUrl.pathname = "/postgres";
    const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
    let created = false;
    let removed = false;
    t.after(async () => {
      try {
        if (created && !removed) await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    });
    assert.equal(
      (await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [databaseName])).rowCount,
      0,
    );
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    const databaseUrl = new URL(baseUrl);
    databaseUrl.pathname = `/${databaseName}`;
    t.mock.method(globalThis, "fetch", async () => {
      assert.fail("Budget-skipped evaluation must not contact an external provider.");
    });
    const selected = resolveFlagReadPolicy(searchStrategy);
    const entries = await runFlagReadLiveEvaluation(
      { databaseUrl: databaseUrl.toString(), budgetMicrodollars: 10 },
      heldoutFlagReadCases,
      undefined,
      { searchStrategy },
    );
    assert.equal(entries.length, heldoutFlagReadCases.length);
    assert.ok(entries.every((entry) => entry.skipped === true));
    assert.ok(entries.every((entry) => entry.investigationComplete === null));
    assert.ok(entries.every((entry) => entry.monitorVersion === selected.monitorVersion));
    assert.ok(entries.every((entry) => entry.promptHash === selected.promptHash));
    assert.ok(entries.every((entry) => entry.searchStrategy === selected.searchStrategy));
    const skippedDatabase = new Pool({ connectionString: databaseUrl.toString(), max: 1 });
    try {
      const seeded = await skippedDatabase.query<{ games: string; reviews: string }>(
        "SELECT (SELECT count(*) FROM ctf.games)::text AS games,(SELECT count(*) FROM ctf.monitor_reviews)::text AS reviews",
      );
      assert.deepEqual(seeded.rows, [{ games: "0", reviews: "0" }]);
    } finally {
      await skippedDatabase.end();
    }
    let active = -1;
    for (let attempt = 0; attempt < 20; attempt++) {
      const { rows } = await admin.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname=$1",
        [databaseName],
      );
      active = Number(rows[0].count);
      if (active === 0) break;
      await delay(25);
    }
    assert.equal(active, 0, "Evaluator released its disposable database connections.");
    await admin.query(`DROP DATABASE "${databaseName}"`);
    removed = true;
  });
