import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyRunFinalizingState,
  applySessionSnapshot,
  createSessionUIState,
  isCurrentSessionCreateFence,
  isTerminalRunStatus,
  keepSelectedSessionProjection,
  mergeSessionEvent,
  pickSession,
  projectSelectedSession,
  runHasStarted,
  sessionLoading,
  setSessionBusy,
  stopAllSessions,
  type SessionUIMap,
} from "../app/session-ui-state";
import type { GameEvent } from "../lib/types";

const user = (id: number): GameEvent => ({ id, kind: "user", text: `turn ${id}` });
const initial = (): SessionUIMap => ({
  alpha: createSessionUIState({ id: "alpha", events: [user(1)] }),
  beta: createSessionUIState({ id: "beta", events: [user(2)] }),
});

test("a finalizing state update locks the run without replacing its transcript", () => {
  const run = {
    id: "run",
    sessionId: "alpha",
    status: "active",
    busy: false,
    sessionBusy: false,
    events: [user(1)],
    sessions: [
      { id: "alpha", ordinal: 1, agentModel: "m", agentEffort: "medium", turns: 1, busy: true },
      { id: "beta", ordinal: 2, agentModel: "m", agentEffort: "medium", turns: 0, busy: false },
    ],
  } as unknown as import("../lib/types").PublicGame;
  const finalizing = applyRunFinalizingState(run, "alpha");
  assert.equal(finalizing.status, "finalizing");
  assert.equal(finalizing.busy, true);
  assert.equal(finalizing.sessionBusy, true);
  assert.deepEqual(finalizing.events, run.events);
  assert.equal(finalizing.sessions?.find((session) => session.id === "beta")?.busy, false);
  assert.equal(finalizing.sessions?.find((session) => session.id === "alpha")?.busy, true);

  const caught = { ...run, status: "caught" } as typeof run;
  assert.equal(isTerminalRunStatus(caught.status), true);
  assert.equal(isTerminalRunStatus("finalizing"), false);
  assert.equal(applyRunFinalizingState(caught, "alpha"), caught);
});

test("a delayed session-create response is fenced after logout, account change, run replacement, or retry", () => {
  const origin = { request: 4, owner: "alice", epoch: 8, runId: "run-a" };
  assert.equal(isCurrentSessionCreateFence(origin, { ...origin }), true);
  assert.equal(
    isCurrentSessionCreateFence(origin, { ...origin, owner: undefined, epoch: 9 }),
    false,
    "logout invalidates the owner and account epoch",
  );
  assert.equal(
    isCurrentSessionCreateFence(origin, { ...origin, runId: "run-b" }),
    false,
    "replacing the run invalidates the origin",
  );
  assert.equal(
    isCurrentSessionCreateFence(origin, { ...origin, request: 5 }),
    false,
    "a newer create request invalidates an older response",
  );
});

test("switching the selected session leaves its sibling stream and draft intact", () => {
  const started = {
    ...initial(),
    alpha: { ...createSessionUIState({ id: "alpha", events: [user(1)] }), draft: "finish the fix" },
  };
  const alphaStreaming = setSessionBusy(started, "alpha", true, "Agent thinking");
  const bothStreaming = setSessionBusy(alphaStreaming, "beta", true, "Reviewing command");
  const afterSwitch = setSessionBusy(bothStreaming, "beta", false, "");
  assert.equal(afterSwitch.alpha.busy, true);
  assert.equal(afterSwitch.alpha.stage, "Agent thinking");
  assert.equal(afterSwitch.alpha.draft, "finish the fix");
  assert.equal(afterSwitch.beta.busy, false);
  assert.equal(afterSwitch.beta.stage, "");
  assert.deepEqual(
    afterSwitch.alpha.events.map((event) => event.id),
    [1],
  );
});

test("SSE event merging does not advance the confirmed fetch cursor", () => {
  const state = initial();
  const streamed = mergeSessionEvent(state, "alpha", { id: 8, kind: "agent", text: "live" });
  assert.equal(streamed.alpha.cursor, 1);
  assert.deepEqual(
    streamed.alpha.events.map((event) => event.id),
    [1, 8],
  );
  const fetched = applySessionSnapshot(streamed, "alpha", [user(8)], 8);
  assert.equal(fetched.alpha.cursor, 8);
  assert.deepEqual(
    fetched.alpha.events.map((event) => event.id),
    [1, 8],
  );
});

test("a persisted instruction replaces its optimistic entry in the same session", () => {
  const state = {
    alpha: {
      ...createSessionUIState({ id: "alpha", events: [user(1)] }),
      events: [user(1), { id: -1, kind: "user" as const, text: "go" }],
    },
  };
  const merged = mergeSessionEvent(state, "alpha", { id: 2, kind: "user", text: "go" });
  assert.deepEqual(
    merged.alpha.events.map((event) => event.id),
    [1, 2],
  );
});

test("a refused instruction's placeholder replaces its optimistic entry, streamed or fetched", () => {
  const placeholder: GameEvent = {
    id: 2,
    kind: "user",
    text: "[A submission was refused by the jailbreak screen. Its text is withheld.]",
    refused: true,
  };
  const state = {
    alpha: {
      ...createSessionUIState({ id: "alpha", events: [user(1)] }),
      events: [user(1), { id: -1, kind: "user" as const, text: "typed text" }],
    },
  };
  for (const merged of [
    mergeSessionEvent(state, "alpha", placeholder),
    applySessionSnapshot(state, "alpha", [user(1), placeholder], 2),
  ])
    assert.deepEqual(
      merged.alpha.events.map((event) => event.id),
      [1, 2],
    );
});

test("selecting a session keeps aggregate run turns and finds starts in sibling transcripts", () => {
  const run = {
    id: "run",
    sessionId: "beta",
    turns: 6,
    busy: false,
    sessionBusy: false,
    events: [],
    sessions: [
      {
        id: "alpha",
        ordinal: 1,
        agentModel: "model/a",
        agentEffort: "low",
        systemPrompt: "",
        turns: 2,
        busy: false,
      },
      {
        id: "beta",
        ordinal: 2,
        agentModel: "model/b",
        agentEffort: "medium",
        systemPrompt: "",
        turns: 1,
        busy: false,
      },
      {
        id: "gamma",
        ordinal: 3,
        agentModel: "model/c",
        agentEffort: "high",
        systemPrompt: "",
        turns: 3,
        busy: false,
      },
    ],
  } as unknown as import("../lib/types").PublicGame;
  const projected = projectSelectedSession(run, run.sessions[1], [user(7)]);
  assert.equal(projected.turns, 6);
  assert.equal(projected.agentModel, "model/b");
  assert.deepEqual(
    projected.events.map((event) => event.id),
    [7],
  );

  const views = { alpha: createSessionUIState({ id: "alpha", events: [user(1)] }) };
  assert.equal(runHasStarted({ ...run, sessionId: "beta", events: [] }, views), true);
});

test("terminal run state stops every local session and clears pending controls", () => {
  const alpha = setSessionBusy(initial(), "alpha", true, "Thinking");
  const beta = setSessionBusy(alpha, "beta", true, "Reviewing");
  const stopped = stopAllSessions(beta);
  assert.deepEqual(
    Object.values(stopped).map(({ busy, stage }) => [busy, stage]),
    [
      [false, ""],
      [false, ""],
    ],
  );
});

test("a late sibling stream updates its session without replacing the selected live turn", () => {
  const state = mergeSessionEvent(initial(), "alpha", { id: 9, kind: "agent", text: "late" });
  assert.deepEqual(
    state.alpha.events.map((event) => event.id),
    [1, 9],
  );
  assert.deepEqual(
    state.beta.events.map((event) => event.id),
    [2],
  );
});

test("a late sibling done frame updates run status while retaining the selected transcript", () => {
  const current = {
    id: "run",
    sessionId: "beta",
    status: "active",
    agentModel: "model/beta",
    agentEffort: "low",
    systemPrompt: "beta plan",
    sessionBusy: false,
    events: [user(2)],
    sessions: [],
  } as unknown as import("../lib/types").PublicGame;
  const next = {
    ...current,
    sessionId: "alpha",
    status: "caught" as const,
    agentModel: "model/alpha",
    events: [user(9)],
    turns: 8,
  };
  const merged = keepSelectedSessionProjection(current, next);
  assert.equal(merged.status, "caught");
  assert.equal(merged.turns, 8);
  assert.equal(merged.sessionId, "beta");
  assert.equal(merged.agentModel, "model/beta");
  assert.deepEqual(
    merged.events.map((event) => event.id),
    [2],
  );
  assert.equal(
    keepSelectedSessionProjection({ ...current, status: "caught" }, { ...next, status: "active" })
      .status,
    "caught",
  );
  assert.equal(
    keepSelectedSessionProjection(
      { ...current, status: "finalizing" },
      { ...next, status: "active" },
    ).status,
    "finalizing",
    "stale stream completion cannot release finalization",
  );
  assert.equal(
    keepSelectedSessionProjection(
      { ...current, status: "finalizing" },
      { ...next, status: "active" },
      true,
    ).status,
    "active",
    "authoritative refresh can release a failed finalization",
  );
  assert.equal(
    keepSelectedSessionProjection(
      { ...current, status: "caught" },
      { ...next, status: "active" },
      true,
    ).status,
    "caught",
    "authoritative stale active data cannot overwrite a terminal catch",
  );
  for (const status of ["active", "finalizing", "creating"] as const)
    assert.equal(
      keepSelectedSessionProjection({ ...current, status: "caught" }, { ...next, status }).status,
      "caught",
      `stale ${status} session fetch cannot reopen a caught run`,
    );
  const caughtWithSource = {
    ...current,
    status: "caught" as const,
    busy: false,
    caughtSessionId: "alpha",
    caughtSessionOrdinal: 1,
    caughtReason: "Prepared flag read",
  };
  const stale = {
    ...next,
    status: "finalizing" as const,
    busy: true,
    caughtSessionId: null,
    caughtSessionOrdinal: null,
    caughtReason: null,
  };
  const preserved = keepSelectedSessionProjection(caughtWithSource, stale);
  assert.equal(preserved.caughtSessionId, "alpha");
  assert.equal(preserved.caughtSessionOrdinal, 1);
  assert.equal(preserved.caughtReason, "Prepared flag read");
  assert.equal(preserved.busy, false);
});

test("a session view records whether its events were fetched", () => {
  const unfetched = createSessionUIState({ id: "beta", systemPrompt: "plan" });
  assert.equal(unfetched.fetched, false, "a sibling created without events is not fetched");
  assert.equal(unfetched.systemPrompt, "plan");
  assert.equal(createSessionUIState({ id: "alpha", events: [] }).fetched, true);
  const state = { beta: unfetched };
  const streamed = mergeSessionEvent(state, "beta", user(3));
  assert.equal(streamed.beta.fetched, false, "a stream event does not count as a fetch");
  const loaded = applySessionSnapshot(streamed, "beta", [], 0);
  assert.equal(loaded.beta.fetched, true, "an empty snapshot is still a fetch");
  assert.equal(state.beta.fetched, false, "inputs are not mutated");
});

test("stopping all sessions keeps the fetched flag and clears live turns", () => {
  const live = { reasoning: "", text: "partial", calls: [] };
  const state: SessionUIMap = {
    alpha: { ...createSessionUIState({ id: "alpha", events: [user(1)] }), live },
  };
  const stopped = stopAllSessions(state);
  assert.equal(stopped.alpha.fetched, true);
  assert.equal(stopped.alpha.live, undefined);
  assert.equal(state.alpha.live, live);
});

test("the focused session falls back to the run's own session when the id belongs elsewhere", () => {
  const live = {
    id: "live",
    sessionId: "alpha",
    sessionBusy: false,
    events: [],
    sessions: [
      { id: "alpha", ordinal: 1, busy: false },
      { id: "beta", ordinal: 2, busy: true },
    ],
  } as unknown as import("../lib/types").PublicGame;
  assert.equal(pickSession(live, "beta"), "beta");
  assert.equal(pickSession(live, "detail-session"), "alpha", "a My Runs detail session is foreign");
  assert.equal(pickSession(live, null), "alpha");
});

test("a session is loading while busy or unconfirmed, preferring local state over the summary", () => {
  const live = {
    id: "live",
    sessionId: "alpha",
    sessionBusy: true,
    events: [],
    sessions: [
      { id: "alpha", ordinal: 1, busy: false },
      { id: "beta", ordinal: 2, busy: true },
    ],
  } as unknown as import("../lib/types").PublicGame;
  assert.equal(sessionLoading(live, {}, "beta"), true, "summary busy");
  assert.equal(sessionLoading(live, {}, "alpha"), false, "summary idle wins over run flag");
  assert.equal(sessionLoading(live, {}, "gone"), true, "unknown session uses the run flag");
  const views = { beta: { ...createSessionUIState({ id: "beta", events: [] }), busy: false } };
  assert.equal(sessionLoading(live, views, "beta"), false, "local idle wins over summary");
  const unconfirmed = { alpha: { ...createSessionUIState({ id: "alpha" }), unconfirmed: true } };
  assert.equal(sessionLoading(live, unconfirmed, "alpha"), true);
});

test("a stop request lasts until its session is idle", () => {
  const stopping = {
    ...initial(),
    alpha: { ...createSessionUIState({ id: "alpha" }), busy: true, stopping: true },
  };
  assert.equal(setSessionBusy(stopping, "alpha", true, "").alpha.stopping, true);
  assert.equal(setSessionBusy(stopping, "alpha", false, "").alpha.stopping, false);
  assert.equal(stopAllSessions(stopping).alpha.stopping, false);
  assert.equal(stopping.alpha.stopping, true, "the input is not changed");
});
