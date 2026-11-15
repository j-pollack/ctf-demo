import { isIP } from "node:net";
import { configuredFlagEndpoint } from "../lib/flag-submission-protocol";

export type SmokeConfig = {
  databaseUrl: string;
  endpoint: string;
  hostname: string;
  controlUrl: string;
  spriteToken: string;
};

export function parseSmokeConfig(env: Record<string, string | undefined>): SmokeConfig {
  if (env.CTF_SMOKE_DISPOSABLE !== "1") throw new Error("CTF_SMOKE_DISPOSABLE=1 is required.");
  const databaseUrl = env.CTF_SMOKE_DATABASE_URL;
  if (!databaseUrl) throw new Error("CTF_SMOKE_DATABASE_URL is required.");
  let database: URL;
  try {
    database = new URL(databaseUrl);
  } catch {
    throw new Error("CTF_SMOKE_DATABASE_URL is invalid.");
  }
  if (
    !["postgres:", "postgresql:"].includes(database.protocol) ||
    !/^\/ctf_smoke_[a-z0-9_]{4,64}$/.test(database.pathname) ||
    database.hash
  )
    throw new Error("CTF_SMOKE_DATABASE_URL must name a dedicated ctf_smoke_* database.");
  const seen = new Set<string>();
  for (const [key, value] of database.searchParams) {
    if (
      seen.has(key) ||
      (key === "sslmode" && value !== "verify-full") ||
      (key === "channel_binding" && value !== "require") ||
      (key !== "sslmode" && key !== "channel_binding")
    )
      throw new Error("CTF_SMOKE_DATABASE_URL has unsafe TLS or query options.");
    seen.add(key);
  }
  database.searchParams.set("sslmode", "verify-full");
  if (env.CTF_SMOKE_DATABASE_NAME !== database.pathname.slice(1))
    throw new Error("CTF_SMOKE_DATABASE_NAME must match the dedicated database.");
  if (!env.SPRITE_TOKEN) throw new Error("SPRITE_TOKEN is required.");
  const { url: endpoint, hostname } = configuredFlagEndpoint(env);
  const rawControl = env.CTF_SMOKE_CONTROL_URL;
  if (!rawControl) throw new Error("CTF_SMOKE_CONTROL_URL is required.");
  let control: URL;
  try {
    control = new URL(rawControl);
  } catch {
    throw new Error("CTF_SMOKE_CONTROL_URL must be a canonical HTTPS URL.");
  }
  if (
    control.protocol !== "https:" ||
    control.port ||
    control.username ||
    control.password ||
    control.search ||
    control.hash ||
    !control.hostname.includes(".") ||
    isIP(control.hostname) !== 0 ||
    control.hostname === "localhost" ||
    control.toString() !== rawControl
  )
    throw new Error("CTF_SMOKE_CONTROL_URL must be a canonical HTTPS URL.");
  if (control.hostname === hostname)
    throw new Error("CTF_SMOKE_CONTROL_URL must use an unrelated hostname.");
  return {
    databaseUrl: database.toString(),
    endpoint,
    hostname,
    controlUrl: rawControl,
    spriteToken: env.SPRITE_TOKEN,
  };
}

export function classifyControlDenial(
  outsideStatus: number,
  inside: { exitCode: number; output: string },
): boolean {
  return (
    outsideStatus === 200 &&
    ((inside.exitCode === 6 && /curl: \(6\) Could not resolve host/i.test(inside.output)) ||
      (inside.exitCode === 7 && /curl: \(7\) Failed to connect/i.test(inside.output))) &&
    !/HTTP:(?!000)\d{3}/.test(inside.output)
  );
}
