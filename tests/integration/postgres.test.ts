import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { closePool } from "./postgres";

const runner = new URL(process.env.CTF_INTEGRATION_DATABASE_URL ?? "http://missing");
assert.equal(process.env.NODE_ENV, "test", "Use npm run test:integration");
assert.equal(runner.hostname, "127.0.0.1");
assert.match(runner.pathname, /^\/ctf_integration_[a-f0-9]{32}$/);

test("closing an unused pool needs no connection", async () => {
  const pool = new Pool({ connectionString: runner.toString() });
  await closePool(pool);
  assert.equal(pool.totalCount, 0);
  assert.equal(pool.ended, true);
});

test("closing a pool waits for every socket before dropping its database", async () => {
  const name = `ctf_integration_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: runner.toString(), max: 1 });
  const connection = new URL(runner);
  connection.pathname = `/${name}`;
  const pool = new Pool({
    connectionString: connection.toString(),
    max: 3,
    connectionTimeoutMillis: 5000,
  });
  const closed: Promise<void>[] = [];
  pool.on("connect", (client) => {
    closed.push(new Promise<void>((resolve) => client.once("end", resolve)));
  });
  let removals = 0;
  pool.on("remove", () => {
    removals++;
  });
  let created = false;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    const clients = await Promise.allSettled(Array.from({ length: 3 }, () => pool.connect()));
    for (const result of clients) if (result.status === "fulfilled") result.value.release();
    for (const result of clients) if (result.status === "rejected") throw result.reason;
    assert.equal(pool.totalCount, 3);
    await closePool(pool);
    assert.equal(removals, 3, "closePool must await all socket-close callbacks");
    assert.equal(pool.totalCount, 0);
  } finally {
    // Even the pre-fix regression must clean up without terminating closing sockets.
    try {
      if (!pool.ending) await closePool(pool);
      await Promise.all(closed);
    } finally {
      try {
        if (created) {
          await admin.query(`DROP DATABASE "${name}"`);
          assert.equal(
            (await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [name])).rowCount,
            0,
          );
        }
      } finally {
        await admin.end();
      }
    }
  }
});
