export type GameStatus = "creating" | "active" | "captured" | "exhausted" | "ended";
export type GameEvent = {
  id: number;
  kind: "user" | "agent" | "tool" | "monitor" | "error";
  text: string;
  reasoning?: string;
  command?: string;
  decision?: "allow" | "block" | "error";
  turn?: number;
};
export type PublicGame = {
  id: string;
  status: GameStatus;
  agentModel: string;
  monitorModel: string;
  tokenBudget: number;
  tokensUsed: number;
  turns: number;
  blocks: number;
  busy: boolean;
  events: GameEvent[];
};
