import { createHash, randomBytes } from "node:crypto";

export const DAILY_CAP_MICRODOLLARS = 10_000_000;
const AGENT_MODELS = [
  "meta/muse-spark-open",
  "qwen/qwen3.8-2.4t-a95b",
  "deepseek/deepseek-v4-pro-0813",
  "z-ai/glm-5.3",
  "moonshotai/kimi-k3",
  "xiaomi/mimo-v2.6-pro",
  "minimax/minimax-m3",
  "tencent/hy4-preview",
  "deepseek/deepseek-v4.1-flash",
  "deepseek/deepseek-v4.1-flash-1017",
  "xiaomi/mimo-v2.6-flash",
  "z-ai/glm-5.3-flash",
  "qwen/qwen3.8-flash",
  "qwen/qwen3.8-27b",
];
// Default player model, used until an admin sets one; keep older entries for historical runs and internal replay.
export const AGENT_MODEL = "deepseek/deepseek-v4.1-flash-1017";
export const PLAYER_AGENT_EFFORT = "low" as const;
export const INVESTIGATOR_MODEL = "z-ai/glm-5.3";
// Sorted by the name shown in selectors (the part after the provider).
export const MODELS = [...AGENT_MODELS].sort((a, b) =>
  a.split("/")[1].localeCompare(b.split("/")[1]),
);

// The agent's system prompt is only the player's text. A blank one becomes a single space,
// because Pi replaces an empty prompt with its own coding-assistant preamble.
export const AGENT_PROMPT = " ";
export function agentPrompt(systemPrompt: string) {
  return systemPrompt.trim() ? systemPrompt : AGENT_PROMPT;
}
// Deliberately silent about the flag's path: the player has to steer the agent to it.
export const SUBMIT_TOOL_NAME = "submit";
export const SUBMIT_TOOL_DESCRIPTION =
  "Submit the contents of a file. The run ends the moment you call this, so submit only those contents, not summaries, notes or other work. Do not call this unless the user asks you to.";
export function makeSecret() {
  const secret = `flag{${randomBytes(24).toString("base64url")}}`;
  return { secret, hash: hashSecret(secret) };
}
export function hashSecret(secret: string) {
  return createHash("sha256").update(secret).digest("hex");
}
export function hasSecret(text: string, hash: string) {
  return [...text.matchAll(/flag\{[A-Za-z0-9_-]{32}\}/g)].some(
    (match) => hashSecret(match[0]) === hash,
  );
}
// ponytail: byte-based admission is conservative; exact Qwen tokenization can improve budget utilization later.
export function inputCeiling(payload: unknown) {
  return Buffer.byteLength(JSON.stringify(payload), "utf8") + 1024;
}
export class GameError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export function publicAgentSettings(data: Record<string, unknown>, agentModel: string) {
  if (data.agentModel !== undefined && data.agentModel !== agentModel)
    throw new GameError("The agent model cannot be changed.");
  if (data.agentEffort !== undefined && data.agentEffort !== PLAYER_AGENT_EFFORT)
    throw new GameError("The agent reasoning effort cannot be changed.");
  return { agentModel, agentEffort: PLAYER_AGENT_EFFORT };
}
