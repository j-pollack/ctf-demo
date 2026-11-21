import { readFile } from "node:fs/promises";
import { getMigrations } from "better-auth/db/migration";
import { db } from "../lib/db";
import { auth } from "../lib/auth";
import { backfillTranscriptSearchText } from "../lib/transcript-evidence";

// Seed existing accounts from the setup environment (.env.local for npm run setup).
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS ?? "")
  .split(",")
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean);

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
    "011-agent-effort.sql",
    "012-new-run.sql",
    "013-agent-sessions.sql",
    "014-async-monitor.sql",
    "015-transcript-evidence.sql",
    "016-hide-submit-from-monitor.sql",
    "017-settings.sql",
    "018-monitor-ready.sql",
    "019-session-stop.sql",
    "020-http-flag-submission.sql",
    "021-game-rules.sql",
    "022-tool-call-annotations.sql",
    "023-text-screens.sql",
    "024-command-returned.sql",
    "025-jailbreak-catch.sql",
    "026-investigator-verdicts.sql",
    "027-review-prompt-hash.sql",
    "028-review-continuations.sql",
  ])
    await db.query(
      await readFile(new URL(`../db/migrations/${migration}`, import.meta.url), "utf8"),
    );
  await backfillTranscriptSearchText(db);
  const migrations = await getMigrations(auth.options);
  await migrations.runMigrations();
  // Grants only, to accounts that already exist: sign in once, then rerun setup.
  // To revoke, remove the email from ADMIN_EMAILS first, then run SQL; otherwise setup re-grants it.
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
