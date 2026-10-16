export type GameStatus = "creating" | "active" | "captured" | "exhausted" | "ended";
export type GameEvent = {
  id: number;
  kind: "user" | "agent" | "tool" | "monitor" | "error";
  text: string;
  reasoning?: string;
  command?: string;
  decision?: "allow" | "block" | "error";
  turn?: number;
  model?: string;
};
export type Season = {
  id: string;
  name: string;
  startsAt: string | null;
  endsAt: string | null;
  monitorModel: string;
};
export type PublicGame = {
  id: string;
  status: GameStatus;
  agentModel: string;
  monitorModel: string;
  systemPrompt: string;
  tokenBudget: number;
  tokensUsed: number;
  budgetMicrodollars: number;
  spentMicrodollars: number;
  reservedMicrodollars: number;
  agentSpendMicrodollars: number;
  monitorSpendMicrodollars: number;
  season: Season;
  turns: number;
  blocks: number;
  busy: boolean;
  events: GameEvent[];
};
export type GameSummary = Pick<
  PublicGame,
  | "id"
  | "status"
  | "agentModel"
  | "monitorModel"
  | "turns"
  | "blocks"
  | "budgetMicrodollars"
  | "spentMicrodollars"
  | "reservedMicrodollars"
> & {
  createdAt: string;
  season: Pick<Season, "id" | "name" | "startsAt" | "endsAt">;
};
