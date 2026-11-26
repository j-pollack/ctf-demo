import { execFileSync } from "node:child_process";
import { limitEnvProblems } from "../lib/limits";

// Neon `vercel-dev`: the shared Preview/Development database that local dev also uses.
const SHARED_DATABASE_ENDPOINT = "ep-wild-bird-arrztsd4";

// Production migrates only through the gated `migrate prod` workflow. A preview migrates its
// own Neon branch (a fresh copy of production) before building, so new auth fields exist.
export function shouldMigrate(env: Record<string, string | undefined>) {
  if (env.VERCEL_ENV !== "preview") return false;
  const url = env.DATABASE_URL_UNPOOLED ?? env.DATABASE_URL;
  if (!url) throw new Error("Preview has no database URL; check the Neon integration.");
  if (new URL(url).hostname.startsWith(SHARED_DATABASE_ENDPOINT))
    throw new Error(
      "Preview has no Neon branch of its own and would migrate the shared vercel-dev database. " +
        "Free a Neon branch (branch limit?) and redeploy.",
    );
  return true;
}

// A production or preview deploy needs the twelve limit variables, so a missing one fails the
// build instead of surfacing as a silent default.
export function deployEnvProblems(env: Record<string, string | undefined>) {
  const none = { missing: [], invalid: [] };
  return env.VERCEL_ENV === "production" || env.VERCEL_ENV === "preview"
    ? limitEnvProblems(env)
    : none;
}

function assertDeployEnv(env: Record<string, string | undefined>) {
  const { missing, invalid } = deployEnvProblems(env);
  if (!missing.length && !invalid.length) return;
  throw new Error(
    [
      missing.length && `Missing limit variables: ${missing.join(", ")}.`,
      invalid.length && `Invalid limit variables: ${invalid.join(", ")}.`,
      "Set them in Vercel for this environment, see .env.example for the allowed values.",
    ]
      .filter(Boolean)
      .join(" "),
  );
}

if (import.meta.main) {
  assertDeployEnv(process.env);
  if (shouldMigrate(process.env))
    execFileSync(process.execPath, ["--import", "tsx", "scripts/setup.ts"], { stdio: "inherit" });
  execFileSync("npm", ["run", "build"], { stdio: "inherit" });
}
