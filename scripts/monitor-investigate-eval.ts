export type EvaluationArguments = {
  mode: "dry-run" | "live" | "help";
  budgetMicrodollars?: number;
};

export type EvaluationEnvironment = {
  [key: string]: string | undefined;
  CTF_INTEGRATION_DATABASE_URL?: string | undefined;
  OPENROUTER_API_KEY?: string | undefined;
};

export type LiveEvaluationConfig = {
  databaseUrl: string;
  budgetMicrodollars: number;
};

export function parseArguments(args: string[]): EvaluationArguments {
  let mode: EvaluationArguments["mode"] = "dry-run";
  let budgetMicrodollars: number | undefined;
  let liveSelected = false;
  let dryRunSelected = false;
  let dryRunArgument = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      if (args.length !== 1) throw new Error("--help cannot be combined with other options.");
      return { mode: "help" };
    }
    if (arg === "--live") {
      if (liveSelected) throw new Error("--live may only be supplied once.");
      if (dryRunSelected) throw new Error("--live cannot be combined with --dry-run.");
      liveSelected = true;
      mode = "live";
      continue;
    }
    if (arg === "--dry-run") {
      if (liveSelected) throw new Error("--dry-run cannot be combined with --live.");
      if (dryRunArgument) throw new Error("--dry-run may only be supplied once.");
      dryRunArgument = true;
      dryRunSelected = true;
      continue;
    }
    if (arg === "--budget-usd") {
      if (budgetMicrodollars !== undefined)
        throw new Error("--budget-usd may only be supplied once.");
      const raw = args[++index];
      if (!raw || !/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(raw))
        throw new Error(
          "--budget-usd must be a positive decimal with at most six fractional digits.",
        );
      const [whole, fraction = ""] = raw.split(".");
      const microdollars = Number(whole) * 1_000_000 + Number(fraction.padEnd(6, "0"));
      if (!Number.isSafeInteger(microdollars) || microdollars <= 0)
        throw new Error("--budget-usd must be a positive safe amount.");
      budgetMicrodollars = microdollars;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  if (mode === "live" && budgetMicrodollars === undefined)
    throw new Error("--live requires --budget-usd <total-dollar-budget>.");
  if (mode === "dry-run" && budgetMicrodollars !== undefined)
    throw new Error("--budget-usd is only used with --live.");
  return { mode, ...(budgetMicrodollars === undefined ? {} : { budgetMicrodollars }) };
}

export function validateLiveConfig(
  options: EvaluationArguments,
  env: EvaluationEnvironment,
): LiveEvaluationConfig {
  if (options.mode !== "live" || options.budgetMicrodollars === undefined)
    throw new Error("Live evaluation requires --live and a total budget.");
  if (!env.OPENROUTER_API_KEY)
    throw new Error("Live evaluation requires OPENROUTER_API_KEY in the process environment.");
  const raw = env.CTF_INTEGRATION_DATABASE_URL;
  if (!raw) throw new Error("Live evaluation requires CTF_INTEGRATION_DATABASE_URL.");
  let database: URL;
  try {
    database = new URL(raw);
  } catch {
    throw new Error("CTF_INTEGRATION_DATABASE_URL must be a valid PostgreSQL URL.");
  }
  if (database.search || database.hash)
    throw new Error("CTF_INTEGRATION_DATABASE_URL cannot contain query overrides or fragments.");
  if (
    !["postgres:", "postgresql:"].includes(database.protocol) ||
    database.hostname !== "127.0.0.1"
  )
    throw new Error(
      "CTF_INTEGRATION_DATABASE_URL must use PostgreSQL on the 127.0.0.1 loopback interface.",
    );
  if (!/^\/ctf_integration_[a-z0-9_]+$/i.test(database.pathname))
    throw new Error(
      "CTF_INTEGRATION_DATABASE_URL must name a dedicated ctf_integration_* database.",
    );
  return { databaseUrl: database.toString(), budgetMicrodollars: options.budgetMicrodollars };
}
