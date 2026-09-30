import { readFile } from "node:fs/promises";
import { getMigrations } from "better-auth/db/migration";
import { db } from "../lib/db";
import { auth } from "../lib/auth";

try {
  await db.query(await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"));
  await db.query(await readFile(new URL("../db/migrations/002-dollar-seasons.sql", import.meta.url), "utf8"));
  const migrations = await getMigrations(auth.options);
  await migrations.runMigrations();
  console.log("Tripwire game and authentication tables are ready.");
} finally { await db.end(); }
