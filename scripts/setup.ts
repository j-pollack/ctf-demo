import { readFile } from "node:fs/promises";
import { getMigrations } from "better-auth/db/migration";
import { db } from "../lib/db";
import { auth } from "../lib/auth";

// Lowercase. Seeded as admins by every setup run (local dev and production).
const ADMIN_EMAILS = ["jonathan@gnobel.com"];

try {
  await db.query(await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"));
  for (const migration of [
    "002-dollar-seasons.sql",
    "003-monitor-reasoning.sql",
    "005-estimated-settlement.sql",
    "006-system-prompt.sql",
    "007-inference-game-index.sql",
    "008-block-ends-run.sql",
    "009-monitor-choice.sql",
    "010-control-monitor.sql",
  ])
    await db.query(
      await readFile(new URL(`../db/migrations/${migration}`, import.meta.url), "utf8"),
    );
  const migrations = await getMigrations(auth.options);
  await migrations.runMigrations();
  // Grants only, to accounts that already exist: sign in once, then rerun setup.
  // To revoke, remove the email here first, then run SQL; otherwise setup re-grants it.
  const admins = await db.query(
    `UPDATE ctf."user" SET "isAdmin"=true WHERE lower(email)=ANY($1) AND "isAnonymous" IS NOT TRUE AND "isAdmin" IS NOT TRUE RETURNING email`,
    [ADMIN_EMAILS],
  );
  for (const { email } of admins.rows) console.log(`Granted admin to ${email}.`);
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
