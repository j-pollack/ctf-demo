import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldMigrate } from "../scripts/vercel-build";

const own = "postgres://u:p@ep-own-branch-123.c-4.us-west-2.aws.neon.tech/neondb";
const shared = "postgres://u:p@ep-wild-bird-arrztsd4.c-4.us-west-2.aws.neon.tech/neondb";
const sharedPooled =
  "postgres://u:p@ep-wild-bird-arrztsd4-pooler.c-4.us-west-2.aws.neon.tech/neondb";

test("only previews on their own Neon branch migrate at build", () => {
  assert.equal(shouldMigrate({ VERCEL_ENV: "production", DATABASE_URL_UNPOOLED: own }), false);
  assert.equal(shouldMigrate({ VERCEL_ENV: "development", DATABASE_URL: shared }), false);
  assert.equal(shouldMigrate({ DATABASE_URL: own }), false);
  assert.equal(shouldMigrate({ VERCEL_ENV: "preview", DATABASE_URL_UNPOOLED: own }), true);
  // The unpooled URL is what setup connects to, so it decides.
  assert.equal(
    shouldMigrate({
      VERCEL_ENV: "preview",
      DATABASE_URL_UNPOOLED: own,
      DATABASE_URL: sharedPooled,
    }),
    true,
  );
  assert.throws(
    () => shouldMigrate({ VERCEL_ENV: "preview", DATABASE_URL_UNPOOLED: shared }),
    /shared vercel-dev/,
  );
  assert.throws(
    () => shouldMigrate({ VERCEL_ENV: "preview", DATABASE_URL: sharedPooled }),
    /shared vercel-dev/,
  );
  assert.throws(() => shouldMigrate({ VERCEL_ENV: "preview" }), /no database URL/);
});
