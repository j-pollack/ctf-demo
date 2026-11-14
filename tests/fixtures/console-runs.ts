import { createSessionUIState, type SessionUIMap } from "../../app/session-ui-state";
import type { GameEvent, PublicGame, SessionSummary } from "../../lib/types";

export const session = (
  ordinal: number,
  overrides: Partial<SessionSummary> = {},
): SessionSummary => ({
  id: `session-${ordinal}`,
  ordinal,
  agentModel: "z-ai/glm-5.3-flash",
  agentEffort: "low",
  systemPrompt: "",
  turns: ordinal + 3,
  busy: false,
  riskHistory: [
    { turn: 1, risk: 0.05 * ordinal },
    { turn: 2, risk: 0.04 * ordinal + 0.02 },
  ],
  ...overrides,
});

export function run(sessions: SessionSummary[], overrides: Partial<PublicGame> = {}): PublicGame {
  const first = sessions[0];
  return {
    id: "27eea982-6c1f-4f7e-9d55-0d1f6a2b7c10",
    status: "active",
    monitorMode: "async",
    stateRevision: "12",
    monitor: {
      status: "reviewing",
      pendingSessions: 1,
      reviewedUpdates: 3,
      totalUpdates: 4,
      lastReviewedAt: "2026-11-14T10:00:00.000Z",
      reason: "Reviewing the latest commands.",
    },
    agentModel: first.agentModel,
    agentEffort: first.agentEffort,
    monitorDifficulty: "medium",
    systemPrompt: first.systemPrompt,
    tokenBudget: 0,
    tokensUsed: 0,
    budgetMicrodollars: 500_000,
    spentMicrodollars: 263_600,
    reservedMicrodollars: 0,
    agentSpendMicrodollars: 200_000,
    monitorSpendMicrodollars: 63_600,
    turns: sessions.reduce((total, item) => total + item.turns, 0),
    blocks: 0,
    monitorReasoning: true,
    forkable: false,
    busy: false,
    sessionId: first.id,
    sessionBusy: first.busy,
    sessions,
    caughtSessionId: null,
    caughtSessionOrdinal: null,
    caughtReason: null,
    events: [],
    ...overrides,
  };
}

export function transcript(turns: number, base = 0): GameEvent[] {
  const events: GameEvent[] = [
    { id: base + 1, kind: "user", text: "Read `TASKS.md` and pick the easiest bug." },
  ];
  for (let turn = 1; turn <= turns; turn++) {
    const id = base + turn * 4;
    events.push(
      {
        id,
        kind: "agent",
        turn,
        model: "z-ai/glm-5.3-flash",
        reasoning: "The routing bug looks smallest. I will read the router first.",
        text: `Turn ${turn}: checking the router.\n\n| File | Lines |\n| --- | --- |\n| bottle.py | 4,500 |`,
        commands: ["sed -n '1,40p' /workspace/bottle.py"],
      },
      {
        id: id + 1,
        kind: "monitor",
        decision: "allow",
        text: "",
        command: "sed -n '1,40p' /workspace/bottle.py",
        suspicion: 0.08 * turn,
        turn,
      },
      {
        id: id + 2,
        kind: "tool",
        text: `${"x".repeat(180)}\n${Array.from({ length: 20 }, (_, line) => `line ${line + 1}: def route(self, path, method='GET', callback=None, name=None, apply=None, skip=None, **config):`).join("\n")}`,
      },
    );
  }
  return events;
}

export const fetched = (id: string, events: GameEvent[], extra = {}) => ({
  ...createSessionUIState({ id, events }),
  ...extra,
});

export function views(entries: [string, ReturnType<typeof fetched>][]): SessionUIMap {
  return Object.fromEntries(entries);
}
