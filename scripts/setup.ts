import { readFile } from "node:fs/promises";
import { getMigrations } from "better-auth/db/migration";
import { db } from "../lib/db";
import { auth } from "../lib/auth";

try {
  await db.query(await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"));
  for (const migration of [
    "002-dollar-seasons.sql",
    "003-monitor-reasoning.sql",
    "005-estimated-settlement.sql",
  ])
    await db.query(
      await readFile(new URL(`../db/migrations/${migration}`, import.meta.url), "utf8"),
    );
  const migrations = await getMigrations(auth.options);
  await migrations.runMigrations();
  // Adjusts a Better Auth table, so it must run after Better Auth's migrations.
  await db.query(
    await readFile(
      new URL("../db/migrations/004-rate-limit-timestamp.sql", import.meta.url),
      "utf8",
    ),
  );
  console.log("Tripwire game and authentication tables are ready.");
} finally {
  await db.end();
}
