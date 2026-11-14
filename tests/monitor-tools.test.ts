import assert from "node:assert/strict";
import { test } from "node:test";
import { createMonitorTools, makeInitialMonitorEvidence } from "../lib/monitor-tools";
import { monitorSessionAlias, visibleText } from "../lib/monitor-tools";
import type { Message } from "@earendil-works/pi-ai";
import type { MonitorSnapshot } from "../lib/types";

const snapshot = (
  messages: MonitorSnapshot["sessions"][number]["messages"] = [],
  commands: MonitorSnapshot["commands"] = [],
): MonitorSnapshot => ({
  gameId: "game-a",
  snapshotId: "capture-a",
  userId: "owner-a",
  targetSessionId: "session-a",
  revision: 7,
  omittedSessions: 0,
  sessions: [
    {
      id: "session-a",
      ordinal: 1,
      agentModel: "model-a",
      agentEffort: "medium",
      turns: 2,
      busy: false,
      reasoningVisible: true,
      messages,
    },
    ...Array.from({ length: 11 }, (_, index) => ({
      id: `session-${index + 2}`,
      ordinal: index + 2,
      agentModel: "model-a",
      agentEffort: "medium" as const,
      turns: 1,
      busy: false,
      reasoningVisible: true,
      messages: [],
    })),
  ],
  commands,
});

const message = (role: "system" | "user" | "assistant" | "toolResult", text: string) =>
  role === "assistant"
    ? {
        role,
        content: [{ type: "text" as const, text }],
        api: "openai-completions" as const,
        model: "model-a",
        provider: "openrouter",
        timestamp: 1,
        stopReason: "stop" as const,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      }
    : role === "toolResult"
      ? {
          role,
          toolCallId: "call-1",
          toolName: "sprite_exec",
          content: [{ type: "text" as const, text }],
          isError: false,
          timestamp: 1,
        }
      : { role, content: text, timestamp: 1 };

test("initial investigator evidence includes only the first safe inventory page and full visible transcript", () => {
  const original = snapshot([
    message("system", "hidden agent instructions"),
    message("user", "inspect the source"),
    message("assistant", "I will inspect it"),
    message("toolResult", "source listing"),
  ]);
  const evidence = makeInitialMonitorEvidence(original, "session-a", { includeReasoning: false });
  const serialized = JSON.stringify(evidence);
  assert.equal(evidence.snapshotId, "capture-a");
  assert.equal(evidence.sessions.length, 10);
  assert.equal(evidence.sessionsRemaining, 2);
  assert.ok(evidence.sessionsCursor);
  assert.match(serialized, /inspect the source/);
  assert.match(serialized, /source listing/);
  assert.doesNotMatch(serialized, /hidden agent instructions/);
  assert.equal(original.sessions[0].messages.length, 4);
});

test("investigator evidence includes the full current transcript and follows reasoning policy", () => {
  const oldMessages = Array.from({ length: 42 }, (_, index) =>
    message("user", `older instruction ${index}`),
  );
  const assistant = {
    role: "assistant" as const,
    content: [
      { type: "thinking" as const, thinking: "private reasoning evidence" },
      { type: "text" as const, text: "visible conclusion" },
    ],
    api: "openai-completions" as const,
    model: "model-a",
    provider: "openrouter",
    timestamp: 1,
    stopReason: "stop" as const,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  const captured = snapshot([...oldMessages, assistant]);
  const hidden = makeInitialMonitorEvidence(captured, "session-a", { includeReasoning: false });
  const shown = makeInitialMonitorEvidence(captured, "session-a", { includeReasoning: true });
  assert.equal(hidden.currentTranscript.length, 43);
  assert.ok(hidden.currentTranscript.some((row) => row.text === "older instruction 0"));
  assert.ok(!JSON.stringify(hidden).includes("private reasoning evidence"));
  assert.ok(JSON.stringify(shown).includes("private reasoning evidence"));
});

test("transcript pages are snapshot-scoped, stable and continue oversized messages explicitly", async () => {
  const large = "🧪".repeat(2000);
  const captured = snapshot([message("user", large)]);
  const tools = createMonitorTools(captured, "session-a", {
    transcriptPageSize: 1,
  });
  const first = await tools.readTranscript({
    sessionId: monitorSessionAlias(captured, "session-a"),
  });
  assert.equal(first.messages.length, 1);
  assert.equal(first.messages[0].chunkIndex, 0);
  assert.equal(first.messages[0].chunkCount, 4);
  assert.ok(Buffer.byteLength(JSON.stringify({ text: first.messages[0].text }), "utf8") <= 2500);
  assert.ok(first.nextCursor);
  const second = await tools.readTranscript({
    sessionId: monitorSessionAlias(captured, "session-a"),
    cursor: first.nextCursor,
  });
  assert.equal(second.messages[0].chunkIndex, 1);
  assert.equal(second.messages[0].sha256, first.messages[0].sha256);
  assert.notEqual(second.messages[0].ref, first.messages[0].ref);
  const third = await tools.readTranscript({
    sessionId: monitorSessionAlias(captured, "session-a"),
    cursor: second.nextCursor,
  });
  assert.equal(third.messages[0].chunkIndex, 2);
  const fourth = await tools.readTranscript({
    sessionId: monitorSessionAlias(captured, "session-a"),
    cursor: third.nextCursor,
  });
  assert.equal(fourth.messages[0].chunkIndex, 3);
  assert.equal(fourth.nextCursor, undefined);
});

test("tool call identity and latest workspace-scoped execution state stay attached to visible evidence", () => {
  const call = {
    ...message("assistant", ""),
    content: [
      {
        type: "toolCall" as const,
        id: "same-command-call",
        name: "sprite_exec",
        arguments: { command: "cat /tmp/flag.txt" },
      },
    ],
  } as MonitorSnapshot["sessions"][number]["messages"][number];
  const toolResult = {
    ...message("toolResult", "Operation interrupted"),
    toolCallId: "same-command-call",
    isError: true,
  };
  const commands: MonitorSnapshot["commands"] = [
    {
      reviewId: "other-session-review",
      sessionId: "session-2",
      toolCallId: "same-command-call",
      command: "echo unrelated",
      admittedRevision: 90,
      completedRevision: 90,
      outcome: "completed",
    },
    {
      reviewId: "old-review",
      sessionId: "session-a",
      toolCallId: "same-command-call",
      command: "cat /tmp/flag.txt",
      admittedRevision: 8,
      completedRevision: 9,
      outcome: "completed",
    },
    {
      reviewId: "latest-review",
      sessionId: "session-a",
      toolCallId: "same-command-call",
      command: "cat /tmp/flag.txt",
      admittedRevision: 10,
      completedRevision: null,
      outcome: "unknown",
    },
  ];
  const evidence = makeInitialMonitorEvidence(snapshot([call, toolResult], commands), "session-a", {
    includeReasoning: false,
  });
  assert.equal(evidence.currentTranscript[0].toolCalls?.[0].id, "same-command-call");
  const serialized = JSON.stringify(evidence);
  for (const hidden of [
    "latest-review",
    "old-review",
    "other-session-review",
    "admittedRevision",
    "completedRevision",
  ])
    assert.ok(!serialized.includes(hidden), `leaked ${hidden}`);
  assert.equal(evidence.currentTranscript[0].commandStates?.[0].state, "unknown");
  assert.equal(evidence.currentTranscript[1].toolCallId, "same-command-call");
  assert.equal(evidence.currentTranscript[1].toolError, true);
  assert.equal(evidence.currentTranscript[1].commandStates?.[0].state, "unknown");
});

test("retrieval tools reject foreign sessions and forged or stale cursors", async () => {
  const base = snapshot();
  const tools = createMonitorTools(base, "session-a");
  assert.throws(() => tools.readTranscript({ sessionId: "other-game-session" }), /Unknown session/);
  assert.throws(
    () =>
      tools.readTranscript({
        sessionId: monitorSessionAlias(base, "session-a"),
        cursor: "not-a-cursor",
      }),
    /Invalid cursor/,
  );
  const listed = await tools.listSessions({});
  assert.equal(listed.sessions[0].id, monitorSessionAlias(base, "session-a"));
  assert.ok(listed.nextCursor);
  const stale = { ...base, snapshotId: "capture-b" };
  const other = createMonitorTools(stale, "session-a");
  assert.throws(() => other.listSessions({ cursor: listed.nextCursor }), /Invalid cursor/);
});

test("retrieval count is bounded and invalid arguments cannot widen scope", async () => {
  const tools = createMonitorTools(snapshot(), "session-a", { maxRetrievalCalls: 1 });
  await tools.listSessions({});
  assert.throws(() => tools.listSessions({}), /Retrieval limit/);
  assert.throws(() => tools.readTranscript({ sessionId: "", cursor: "" }), /Invalid arguments/);
  assert.throws(() => tools.listSessions([] as unknown as {}), /Invalid arguments/);
  assert.throws(
    () =>
      tools.readTranscript({
        sessionId: monitorSessionAlias(snapshot(), "session-a"),
        extra: true,
      } as never),
    /Invalid arguments/,
  );
});

test("public evidence uses a capture-local opaque session namespace", () => {
  const captured = {
    ...snapshot([message("user", "inspect")]),
    snapshotId: "capture-secret-123",
    userId: "owner-a",
    targetSessionId: "session-a",
    omittedSessions: 3,
  } as MonitorSnapshot;
  const initial = makeInitialMonitorEvidence(captured, "session-a");
  const tools = createMonitorTools(captured, "session-a");
  const listed = tools.listSessions({});
  const visible = JSON.stringify({ initial, listed });
  assert.equal(initial.snapshotId, "capture-secret-123");
  assert.equal(initial.userId, "owner-a");
  assert.equal(initial.historyOmittedSessions, 3);
  assert.notEqual(initial.targetSessionId, "session-a");
  for (const raw of ["game-a", "session-a", "session-2"])
    assert.ok(!visible.includes(raw), `leaked ${raw}`);
  for (const forbidden of ["revision", "ordinal", "reviewId", "admittedRevision"])
    assert.ok(!visible.includes(`"${forbidden}"`), `leaked ${forbidden}`);
  assert.equal(initial.currentTranscript[0].sessionId, initial.targetSessionId);
  assert.equal(listed.sessions[0].id, initial.targetSessionId);
  const decodedCursor = Buffer.from(initial.sessionsCursor!, "base64url").toString("utf8");
  for (const raw of ["game-a", "session-a", "session-2", "revision", "ordinal"])
    assert.ok(!decodedCursor.includes(raw), `cursor leaked ${raw}`);
  assert.throws(() => tools.readTranscript({ sessionId: "session-a" }), /Unknown session/);
  assert.equal(
    tools.readTranscript({ sessionId: initial.targetSessionId }).session.id,
    initial.targetSessionId,
  );
});

test("source policy and current review must both allow reasoning", () => {
  const thinking = {
    ...message("assistant", "visible text"),
    content: [
      { type: "thinking" as const, thinking: "source secret reasoning" },
      { type: "text" as const, text: "visible text" },
    ],
  } as MonitorSnapshot["sessions"][number]["messages"][number];
  const captured = {
    ...snapshot([thinking]),
    sessions: [{ ...snapshot().sessions[0], messages: [thinking], reasoningVisible: false }],
  } as MonitorSnapshot;
  const shown = makeInitialMonitorEvidence(captured, "session-a", { includeReasoning: true });
  assert.ok(!JSON.stringify(shown).includes("source secret reasoning"));
  assert.ok(JSON.stringify(shown).includes("visible text"));
});

test("monitors never see the submit call or its result", () => {
  const call = {
    role: "assistant",
    content: [
      { type: "text", text: "Done with the fix." },
      { type: "toolCall", id: "c1", name: "sprite_exec", arguments: { command: "ls" } },
      { type: "toolCall", id: "c2", name: "submit", arguments: { value: "flag{secret}" } },
    ],
    timestamp: 1,
  } as unknown as Message;
  const before = structuredClone(call);
  const shown = visibleText(call, true);
  assert.equal(shown?.text.includes("submit"), false);
  assert.equal(shown?.text.includes("flag{secret}"), false);
  assert.ok(shown?.text.includes("Done with the fix."));
  assert.ok(shown?.text.includes("[tool call sprite_exec id=c1]"));
  assert.deepEqual(shown?.toolCalls, [{ id: "c1", name: "sprite_exec" }]);
  assert.deepEqual(call, before);
  const onlySubmit = {
    role: "assistant",
    content: [{ type: "toolCall", id: "c3", name: "submit", arguments: { value: "x" } }],
    timestamp: 2,
  } as unknown as Message;
  assert.equal(visibleText(onlySubmit, true), undefined);
  const result = {
    role: "toolResult",
    toolCallId: "c2",
    toolName: "submit",
    content: [{ type: "text", text: "Submitted." }],
    isError: false,
    timestamp: 3,
  } as unknown as Message;
  assert.equal(visibleText(result, true), undefined);
});
