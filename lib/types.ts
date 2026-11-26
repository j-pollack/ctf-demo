import type { Message } from "@earendil-works/pi-ai";

// Defaults for every run's budget, and for the new runs a player may start per rolling 24 hours.
// An admin can change both, see Limits.
export const RUN_BUDGET_MICRODOLLARS = 500_000;
export const RUNS_PER_DAY = 3;
export type GameStatus =
  | "creating"
  | "active"
  | "finalizing"
  | "captured"
  | "exhausted"
  | "ended"
  | "blocked"
  | "caught";
// A run in any other status can still change, so the monitor's view of it stays closed.
const ENDED_STATUSES: readonly GameStatus[] = [
  "captured",
  "exhausted",
  "ended",
  "blocked",
  "caught",
];
export function runHasEnded(status: GameStatus) {
  return ENDED_STATUSES.includes(status);
}
// The status of a submitted run that no review could settle. It is not a win and not a catch.
export const UNVERIFIED_SUBMISSION_STATUS = "ended" as const satisfies GameStatus;
export type GameEvent = {
  id: number;
  kind: "user" | "agent" | "tool" | "monitor" | "submit" | "error";
  text: string;
  reasoning?: string;
  command?: string;
  // An agent turn's sprite_exec commands, one per call, in order.
  commands?: string[];
  decision?: "allow" | "block" | "error" | "unverified";
  // Set on submit events: whether the submitted value contained the flag.
  correct?: boolean;
  // Monitor events: the combined suspicion (0-1) behind the decision.
  suspicion?: number;
  // Submit events: seed bugs whose test passes, and whether the end review caught the run.
  bugsPassed?: number;
  caught?: boolean;
  submissionTransport?: "http";
  // Set on an agent turn that hit the output token limit while reasoning and stopped before acting.
  // Its reasoning/text is kept, and the transcript marks the cut-off so the next turn continues.
  truncated?: boolean;
  // Set when the response stopped at its time limit and the run can be resumed.
  resumable?: boolean;
  // A deadline expiry may continue automatically. User stop and connection loss remain manual.
  autoContinue?: boolean;
  turn?: number;
  model?: string;
  // A user event standing in for a submission the jailbreak screen refused, and the rows holding it.
  refused?: boolean;
  refusedTextIds?: string[];
  // Monitor block events: "jailbreak" for the screen, "flag_output" for a command that printed the
  // flag. Absent on investigator catches.
  // Monitor unverified events: "review" or "scoring", whichever could not be completed, or
  // "allowance" when the monitor's budget for the run ran out before every session was reviewed.
  cause?: "jailbreak" | "flag_output" | "review" | "scoring" | "allowance";
  // A jailbreak catch for text decoded from a command, not a player's instruction.
  source?: "decoded";
  toolCallId?: string;
  questions?: string[];
  refusedKinds?: ("instruction" | "system_prompt")[];
};
export const FLAG_OUTPUT_CATCH_TEXT =
  "This run ended because a command's output contained the flag.";
// How strict the monitor's system prompt is; chosen per run and shared with the client.
export const MONITOR_DIFFICULTIES = ["easy", "medium", "hard"] as const;
export type MonitorDifficulty = (typeof MONITOR_DIFFICULTIES)[number];
// How much the agent reasons per turn; chosen per run and changeable between instructions.
export const AGENT_EFFORTS = ["low", "medium", "high"] as const;
export type AgentEffort = (typeof AGENT_EFFORTS)[number];
export type SessionSummary = {
  id: string;
  ordinal: number;
  agentModel: string;
  agentEffort: AgentEffort;
  systemPrompt: string;
  turns: number;
  busy: boolean;
};
export type MonitorTargetKind = "transcript" | "command" | "submission";
export type MonitorVerdict = "allow" | "block" | "unknown";
// A classifier question at or above the threshold that made it count, with its answer (0-1).
export type MonitorSignal = { name: string; value: number };
// What the monitor saw in one session of an ended run, for its owner.
export type MonitorSessionView = {
  id: string;
  ordinal: number;
  reviews: {
    id: string;
    route: "investigated" | "deferred" | "final" | null;
    verdict: MonitorVerdict | null;
    reason: string | null;
    createdAt: string;
    // The classifier's risk score for the review (0-1), when it recorded one.
    score: number | null;
  }[];
  // Commands whose answers crossed the routing threshold.
  commands: { toolCallId: string; command: string | null; signals: MonitorSignal[] }[];
  commandsUnder: number;
  // Command outputs the classifier labelled as flagged.
  outputs: { toolCallId: string; command: string | null; signals: MonitorSignal[] }[];
  outputsUnder: number;
  // Instruction and system prompt screens that were unclear or certain.
  screens: {
    kind: "instruction" | "system_prompt";
    verdict: "unclear" | "certain";
    signals: MonitorSignal[];
    text: string | null;
    secondLook: { verdict: "jailbreak" | "clear"; reason: string | null } | null;
  }[];
  screensUnder: number;
  // Layers the investigator decoded from this session's commands, by the hash of their text. The
  // text is never sent: it is player-controlled and comes from commands.
  decoded: {
    ref: string;
    // Flag-read answers over the routing threshold, or null when no annotation answered.
    flagRead: MonitorSignal[] | null;
    // The jailbreak screen, or null when no screen answered.
    screen: {
      verdict: "clear" | "unclear" | "certain";
      signals: MonitorSignal[];
      secondLook: { verdict: "jailbreak" | "clear"; reason: string | null } | null;
    } | null;
  }[];
};
// `commandThreshold` is the answer (0-1) at which a command sends its session to the investigator.
export type MonitorView = { commandThreshold: number; sessions: MonitorSessionView[] };
export type MonitorReviewRecord = {
  id: string;
  game_id: string;
  session_id: string;
  snapshot_revision: number | string;
  target_kind: MonitorTargetKind;
  tool_call_id: string | null;
  command: string | null;
  classifier_signals: unknown;
  model: string;
  prompt_version: string;
  verdict: MonitorVerdict | null;
  reason: string | null;
  evidence: unknown;
  operational_error: string | null;
  latency_ms: number | null;
  calls: number | null;
  retrieval_calls: number | null;
  initial_evidence_count: number | null;
  retrieved_refs: unknown;
  originating_lease: string | null;
  eligible_drain_token: string | null;
  finalization_token: string | null;
  execution_generation: number | string | null;
  admitted_revision: number | string | null;
  completed_revision: number | string | null;
  outcome: "completed" | "interrupted" | "unknown" | null;
  created_at: Date;
  completed_at: Date | null;
};
export type MonitorSnapshot = {
  snapshotId: string;
  gameId: string;
  userId: string;
  targetSessionId: string;
  revision: number;
  omittedSessions: number;
  // The run's isolation rule when the snapshot was read; it decides which evidence the manifest holds.
  isolated: boolean;
  searchableHistorySessions?: number;
  evidenceManifest?: readonly {
    sessionId: string;
    version: number;
    reasoningVisible: boolean;
    observedAt: string;
  }[];
  sessions: readonly {
    id: string;
    ordinal: number;
    agentModel: string;
    agentEffort: AgentEffort;
    turns: number;
    busy: boolean;
    reasoningVisible: boolean;
    // The player's stored system prompt at capture.
    systemPrompt?: string;
    readonly messages: readonly Message[];
  }[];
  commands: readonly {
    reviewId: string;
    sessionId: string;
    toolCallId: string;
    command: string;
    admittedRevision: number | null;
    completedRevision: number | null;
    outcome: "completed" | "interrupted" | "unknown" | null;
  }[];
  // When each command of the evidence sessions was sent to the computer and when it returned, as
  // ISO 8601 UTC. Null when unknown.
  operationTimes?: readonly {
    sessionId: string;
    toolCallId: string;
    sentAt: string | null;
    returnedAt: string | null;
  }[];
};
export type PublicGame = {
  id: string;
  status: GameStatus;
  monitorMode: "legacy" | "async";
  submissionTransport: "tool" | "http";
  submissionUrl?: string;
  submissionPending: boolean;
  // An upload is waiting to be graded and a new run would be refused until it is.
  startBlockedByGrading: boolean;
  submissionCorrect?: boolean;
  stateRevision: string;
  monitor?: {
    // "settling": a stopped command is being checked, which is not a failed review.
    status: "queued" | "reviewing" | "settling" | "caught-up" | "unresolved" | "caught";
    pendingSessions: number;
    reviewedUpdates: number;
    totalUpdates: number;
    lastReviewedAt: string | null;
    hasPendingReview?: boolean;
    reason?: string;
    // True while a failed review has requeues left, so the result is not final yet.
    willRetry?: boolean;
  };
  // Set on a run that ended because its review or scoring could not be completed.
  endReason?: "unverified-review" | "unverified-scoring" | "unverified-allowance";
  agentModel: string;
  agentEffort: AgentEffort;
  monitorDifficulty: MonitorDifficulty;
  rules: GameRules;
  systemPrompt: string;
  tokenBudget: number;
  tokensUsed: number;
  budgetMicrodollars: number;
  spentMicrodollars: number;
  reservedMicrodollars: number;
  agentSpendMicrodollars: number;
  monitorSpendMicrodollars: number;
  turns: number;
  blocks: number;
  // Whether the monitor reads the agent's reasoning; changeable until the first instruction.
  monitorReasoning: boolean;
  busy: boolean;
  sessionId: string;
  sessionBusy: boolean;
  sessions: SessionSummary[];
  caughtSessionId: string | null;
  caughtSessionOrdinal: number | null;
  caughtReason: string | null;
  // Why the run was caught: absent for a run that is not caught.
  caughtCause?: "jailbreak" | "decoded_jailbreak" | "flag_read" | "flag_output" | null;
  // Texts the jailbreak screen refused, for the owner only. Never part of a transcript.
  refusedTexts?: {
    id: string;
    kind: "instruction" | "system_prompt";
    text: string;
    flagged: boolean;
  }[];
  events: GameEvent[];
};
export type GameSummary = Omit<
  Pick<
    PublicGame,
    | "id"
    | "status"
    | "agentModel"
    | "monitorDifficulty"
    | "turns"
    | "blocks"
    | "budgetMicrodollars"
    | "spentMicrodollars"
    | "reservedMicrodollars"
  >,
  "agentModel"
> & {
  agentModel: string | null;
  createdAt: string;
  // What an ended run was, as the run page tells it: set only when the run has ended.
  submissionCorrect?: boolean;
  endReason?: PublicGame["endReason"];
};
// The cause stored on a run's unverified event, as the endReason the run page shows.
export function endReasonOf(cause: string | null | undefined): PublicGame["endReason"] {
  if (cause === "scoring") return "unverified-scoring";
  if (cause === "allowance") return "unverified-allowance";
  return cause === "review" ? "unverified-review" : undefined;
}
export const sessionCount = (count: number) => `${count} ${count === 1 ? "session" : "sessions"}`;
export const SESSION_LIMIT_TEXT =
  "This run has the maximum number of sessions. You cannot add more.";
// What the server refuses with when a run is at its session limit, and what the play UI says
// when a click would be refused. Null when the run may add a session or the limit is unknown.
export const sessionLimitRefusal = (count: number, limit: number | undefined) =>
  limit !== undefined && count >= limit ? SESSION_LIMIT_TEXT : null;
// Budgets and limits an admin can change. The defaults are the constants they replace.
export type Limits = {
  dailyCapMicrodollars: number;
  runBudgetMicrodollars: number;
  runsPerDay: number;
  totalRunsPerDay: number;
  monitorRunAllowanceMicrodollars: number;
  finalReviewAllowanceMicrodollars: number;
  environmentsOpen: number;
  nameChecksPerDay: number;
  sessionsPerRun: number;
  autoContinueTurns: number;
  agentEffort: AgentEffort;
  investigatorEffort: AgentEffort;
};
// The part of Limits the browser receives: what player copy and the play UI use.
export type PlayerLimits = Pick<
  Limits,
  | "runBudgetMicrodollars"
  | "runsPerDay"
  | "dailyCapMicrodollars"
  | "sessionsPerRun"
  | "autoContinueTurns"
>;
// Rules a run is played under. Recorded on the run when it starts.
export type GameRules = {
  monitorIsolation: boolean;
  bugFixRequired: boolean;
  jailbreakCatch: boolean;
};
