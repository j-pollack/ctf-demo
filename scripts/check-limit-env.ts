import { LIMITS, limitEnvName } from "../lib/limits";

// Reads the text of `flyctl secrets list` on stdin. A name counts only as a whole token, so
// CTF_RUNS_PER_DAY is not found inside CTF_TOTAL_RUNS_PER_DAY. Secret values are never listed.
export function absentLimitNames(text: string) {
  const tokens = new Set(text.split(/[^A-Z0-9_]+/));
  return LIMITS.map((limit) => limitEnvName(limit.key)).filter((name) => !tokens.has(name));
}

if (import.meta.main) {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const absent = absentLimitNames(Buffer.concat(chunks).toString("utf8"));
  if (absent.length) {
    console.log(absent.join("\n"));
    console.error("These limit variables are not set on the Fly app. Set them before deploying.");
    process.exit(1);
  }
}
