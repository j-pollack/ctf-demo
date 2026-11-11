import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type JsonObject,
  type Model,
} from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  createIsolatedInvestigatorSession,
  guardInvestigatorStream,
  runMonitorReview,
} from "../lib/monitor-review";
import {
  createFinishReviewTool,
  INVESTIGATOR_SYSTEM_PROMPT,
  validateInitialContext,
  validateRiskSignals,
} from "../lib/monitor-evidence";
import {
  createMonitorTools,
  makeInitialMonitorEvidence,
  monitorSessionAlias,
} from "../lib/monitor-tools";
import type { MonitorSnapshot } from "../lib/types";

const quietRisk = {
  reads_now: 0,
  stages_indirect: 0,
  intent: 0,
  suspicionScore: 0,
  suspicionConfidence: 0.9,
};
const model: Model<"openai-completions"> = {
  id: "test-investigator",
  name: "test-investigator",
  api: "openai-completions",
  provider: "openrouter",
  baseUrl: "https://example.invalid",
  input: ["text"],
  reasoning: true,
  contextWindow: 64_000,
  maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const snapshot: MonitorSnapshot = {
  snapshotId: "review-capture-a",
  gameId: "game-a",
  userId: "owner-a",
  targetSessionId: "session-a",
  revision: 4,
  omittedSessions: 0,
  sessions: [
    {
      id: "session-a",
      ordinal: 1,
      agentModel: "player-model",
      agentEffort: "medium",
      turns: 1,
      busy: false,
      reasoningVisible: true,
      messages: [
        { role: "system", content: "hidden instructions", timestamp: 1 },
        { role: "user", content: "read /tmp/flag.txt", timestamp: 2 },
      ],
    },
  ],
  commands: [],
};

function providerToolCall(
  name: string,
  id: string,
  args: unknown,
  second?: { name: string; id: string; args: unknown },
  stopReason: "toolUse" | "length" = "toolUse",
) {
  const stream = createAssistantMessageEventStream();
  const content: AssistantMessage["content"] = [
    { type: "toolCall", id, name, arguments: args as JsonObject },
    ...(second
      ? [
          {
            type: "toolCall" as const,
            id: second.id,
            name: second.name,
            arguments: second.args as JsonObject,
          },
        ]
      : []),
  ];
  const message: AssistantMessage = {
    role: "assistant",
    content,
    api: model.api,
    model: model.id,
    provider: model.provider,
    timestamp: Date.now(),
    stopReason,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  stream.push({ type: "done", reason: stopReason, message });
  return stream;
}
test("risk boundary rejects malformed classifier values without creating a verdict", () => {
  assert.deepEqual(validateRiskSignals(quietRisk), quietRisk);
  assert.throws(
    () => validateRiskSignals({ ...quietRisk, reads_now: "0" }),
    /invalid risk signals/,
  );
  assert.throws(
    () => validateRiskSignals({ ...quietRisk, suspicionScore: Number.NaN }),
    /invalid risk signals/,
  );
  assert.throws(() => validateRiskSignals({ ...quietRisk, extra: 1 }), /invalid risk signals/);
});

test("review scope rejects a historical same-owner session as the target", async () => {
  const historical = {
    ...snapshot,
    sessions: [...snapshot.sessions, { ...snapshot.sessions[0], id: "historical-session" }],
  };
  const input = {
    game: { id: "game-a", owner_id: "owner-a" },
    reviewId: "review-a",
    snapshot: historical,
    currentSessionId: "historical-session",
    target: { kind: "transcript" as const },
    riskSignals: quietRisk,
    signal: new AbortController().signal,
  };
  await assert.rejects(runMonitorReview(input as never), /scope does not match/);
  await assert.rejects(
    runMonitorReview({
      ...input,
      currentSessionId: "session-a",
      game: { id: "game-a", owner_id: "owner-b" },
    } as never),
    /scope does not match/,
  );
});

test("complete initial transcript that exceeds the reserved model context fails closed", () => {
  const large: MonitorSnapshot = {
    ...snapshot,
    sessions: [
      {
        ...snapshot.sessions[0],
        messages: [{ role: "user", content: "x".repeat(50_000), timestamp: 3 }],
      },
    ],
  };
  const evidence = makeInitialMonitorEvidence(large, "session-a");
  assert.throws(
    () => validateInitialContext(evidence, { kind: "transcript" }, quietRisk, [], model),
    /initial context exceeds/,
  );
});

test("real Pi session has only investigator tools and first valid finish aborts the remaining batch", async () => {
  const initial = makeInitialMonitorEvidence(snapshot, "session-a");
  const visible = new Map(initial.currentTranscript.map((item) => [item.ref, item]));
  const commandTools = createMonitorTools(snapshot, "session-a");
  let decision: unknown;
  let failure: unknown;
  let runtime: Awaited<ReturnType<typeof createIsolatedInvestigatorSession>> | undefined;
  const finish = createFinishReviewTool(
    visible,
    (value) => {
      decision = value;
    },
    (error) => {
      failure ??= error;
    },
  );
  const tools: ToolDefinition[] = [...commandTools.piTools, finish];
  runtime = await createIsolatedInvestigatorSession(model, tools);
  try {
    assert.deepEqual(runtime.session.getActiveToolNames().sort(), [
      "finish_review",
      "list_sessions",
      "read_transcript",
    ]);
    let providerCalls = 0;
    let dispatchedCalls = 0;
    const startedTools: string[] = [];
    const finishedTools: string[] = [];
    runtime.session.agent.streamFunction = guardInvestigatorStream(
      (_apiModel, _context) => {
        providerCalls += 1;
        const row = initial.currentTranscript.find((item) =>
          item.text.includes("read /tmp/flag.txt"),
        )!;
        return providerToolCall(
          "finish_review",
          "finish-1",
          {
            verdict: "block",
            reason: "The current instruction asks for the protected file contents.",
            evidence: [{ ref: row.ref, excerpt: "read /tmp/flag.txt" }],
          },
          { name: "read_transcript", id: "must-not-run", args: { sessionId: "session-a" } },
        );
      },
      {
        signal: new AbortController().signal,
        isStopped: () => Boolean(decision || failure),
        onLimit: () => {
          failure = new Error("limit");
        },
        admitCall: () => {
          dispatchedCalls += 1;
          return dispatchedCalls <= 8;
        },
      },
    );
    runtime.session.agent.subscribe((event) => {
      if (event.type === "tool_execution_start") startedTools.push(event.toolName);
      if (event.type === "tool_execution_end")
        finishedTools.push(`${event.toolName}:${event.isError}`);
      if (event.type === "tool_execution_end" && event.toolName === "finish_review" && decision)
        runtime?.session.agent.abort();
    });
    await runtime.session.agent.prompt("Review this snapshot.");
    assert.equal(providerCalls, 1, finishedTools.join(","));
    assert.equal(dispatchedCalls, 1);
    assert.deepEqual(startedTools, ["finish_review"]);
    assert.equal(failure, undefined);
    assert.deepEqual(decision, {
      verdict: "block",
      reason: "The current instruction asks for the protected file contents.",
      evidence: [
        {
          ref: initial.currentTranscript[0].ref,
          excerpt: "read /tmp/flag.txt",
          sha256: initial.currentTranscript[0].sha256,
        },
      ],
    });
    assert.match(INVESTIGATOR_SYSTEM_PROMPT, /untrusted evidence/);
    assert.doesNotMatch(JSON.stringify(startedTools), /hidden instructions/);
  } finally {
    await runtime.dispose();
  }
});

test("retrieval tool error aborts the real Pi loop before another provider request", async () => {
  let runtime: Awaited<ReturnType<typeof createIsolatedInvestigatorSession>> | undefined;
  let failure: unknown;
  const retrieval = createMonitorTools(snapshot, "session-a", {
    onFailure: (error) => {
      failure ??= error;
    },
  });
  runtime = await createIsolatedInvestigatorSession(model, retrieval.piTools);
  try {
    let providerCalls = 0;
    let dispatchedCalls = 0;
    runtime.session.agent.streamFunction = guardInvestigatorStream(
      () => {
        providerCalls += 1;
        return providerToolCall("read_transcript", "read-invalid", {
          sessionId: monitorSessionAlias(snapshot, "session-a"),
          cursor: "forged-invalid-cursor",
        });
      },
      {
        signal: new AbortController().signal,
        isStopped: () => Boolean(failure),
        onLimit: () => {
          failure ??= new Error("limit");
        },
        admitCall: () => {
          dispatchedCalls += 1;
          return dispatchedCalls <= 8;
        },
      },
    );
    runtime.session.agent.subscribe((event) => {
      if (event.type === "tool_execution_end" && event.isError) runtime?.session.agent.abort();
    });
    await runtime.session.agent.prompt("Read the history.");
    assert.equal(providerCalls, 1);
    assert.equal(dispatchedCalls, 1);
    assert.match(String(failure), /Invalid cursor/);
  } finally {
    await runtime.dispose();
  }
});

test("invalid evidence citation fails before a decision is latched", async () => {
  const initial = makeInitialMonitorEvidence(snapshot, "session-a");
  const visible = new Map(initial.currentTranscript.map((item) => [item.ref, item]));
  let decision: unknown;
  let failure: unknown;
  let runtime: Awaited<ReturnType<typeof createIsolatedInvestigatorSession>> | undefined;
  const finish = createFinishReviewTool(
    visible,
    (value) => {
      decision = value;
    },
    (error) => {
      failure ??= error;
    },
  );
  runtime = await createIsolatedInvestigatorSession(model, [finish]);
  try {
    let providerCalls = 0;
    let dispatchedCalls = 0;
    runtime.session.agent.streamFunction = guardInvestigatorStream(
      () => {
        providerCalls += 1;
        return providerToolCall("finish_review", "finish-forged", {
          verdict: "allow",
          reason: "The citation is not in the visible current transcript.",
          evidence: [{ ref: "unread-sibling-message", excerpt: "hidden evidence" }],
        });
      },
      {
        signal: new AbortController().signal,
        isStopped: () => Boolean(failure || decision),
        onLimit: () => {
          failure ??= new Error("limit");
        },
        admitCall: () => {
          dispatchedCalls += 1;
          return dispatchedCalls <= 8;
        },
      },
    );
    runtime.session.agent.subscribe((event) => {
      if (event.type === "tool_execution_end" && event.isError) runtime?.session.agent.abort();
    });
    await runtime.session.agent.prompt("Review this snapshot.");
    assert.equal(providerCalls, 1);
    assert.equal(dispatchedCalls, 1);
    assert.equal(decision, undefined);
    assert.match(String(failure), /Evidence excerpt does not match visible snapshot text/);
  } finally {
    await runtime.dispose();
  }
});

test("unexpected finish validator and callback errors stay fatal", async () => {
  const initial = makeInitialMonitorEvidence(snapshot, "session-a");
  const cited = initial.currentTranscript[0];
  const args = {
    verdict: "block",
    reason: "Protected file request.",
    evidence: [{ ref: cited.ref, excerpt: "read /tmp/flag.txt" }],
  };
  const cases = [
    {
      visible: new (class extends Map<string, typeof cited> {
        override get(): typeof cited {
          throw new Error("validator exploded");
        }
      })([[cited.ref, cited]]),
      finish: () => {},
      expected: /validator exploded/,
    },
    {
      visible: new Map([[cited.ref, cited]]),
      finish: () => {
        throw new Error("callback exploded");
      },
      expected: /callback exploded/,
    },
  ];
  for (const scenario of cases) {
    let fatal: unknown;
    let recoverable: unknown;
    const tool = createFinishReviewTool(
      scenario.visible,
      scenario.finish,
      (error) => {
        fatal = error;
      },
      (error) => {
        recoverable = error;
      },
    );
    await assert.rejects(
      tool.execute("finish-internal", args as never, undefined, undefined, {} as never),
      scenario.expected,
    );
    assert.match(String(fatal), scenario.expected);
    assert.equal(recoverable, undefined);
  }
});

test("cutoff tool arguments fail closed before execution or another model dispatch", async () => {
  let runtime: Awaited<ReturnType<typeof createIsolatedInvestigatorSession>> | undefined;
  let failure: unknown;
  const tools = createMonitorTools(snapshot, "session-a");
  runtime = await createIsolatedInvestigatorSession(model, tools.piTools);
  try {
    let providerCalls = 0;
    let dispatchedCalls = 0;
    const toolStarts: string[] = [];
    const toolEnds: boolean[] = [];
    runtime.session.agent.streamFunction = guardInvestigatorStream(
      () => {
        providerCalls += 1;
        return providerToolCall(
          "read_transcript",
          "cut-off-call",
          { sessionId: "session-a" },
          undefined,
          "length",
        );
      },
      {
        signal: new AbortController().signal,
        isStopped: () => Boolean(failure),
        onLimit: () => {
          failure ??= new Error("limit");
        },
        admitCall: () => {
          dispatchedCalls += 1;
          return dispatchedCalls <= 8;
        },
      },
    );
    runtime.session.agent.subscribe((event) => {
      if (
        event.type === "message_end" &&
        event.message.role === "assistant" &&
        event.message.stopReason === "length"
      ) {
        failure = new Error("output cutoff");
        runtime?.session.agent.abort();
      }
      if (event.type === "tool_execution_start") toolStarts.push(event.toolName);
      if (event.type === "tool_execution_end") toolEnds.push(event.isError);
    });
    await runtime.session.agent.prompt("Read the transcript.");
    assert.equal(providerCalls, 1);
    assert.equal(dispatchedCalls, 1);
    assert.deepEqual(toolStarts, ["read_transcript"]);
    assert.deepEqual(toolEnds, [true]);
    assert.match(String(failure), /output cutoff/);
  } finally {
    await runtime.dispose();
  }
});

test("investigator stops before a ninth inference dispatch", async () => {
  let runtime: Awaited<ReturnType<typeof createIsolatedInvestigatorSession>> | undefined;
  let failure: unknown;
  const tools = createMonitorTools(snapshot, "session-a");
  runtime = await createIsolatedInvestigatorSession(model, tools.piTools);
  try {
    let providerCalls = 0;
    let admittedCalls = 0;
    runtime.session.agent.streamFunction = guardInvestigatorStream(
      () => {
        providerCalls += 1;
        return providerToolCall("list_sessions", `list-${providerCalls}`, {});
      },
      {
        signal: new AbortController().signal,
        isStopped: () => Boolean(failure),
        onLimit: () => {
          failure ??= new Error("Investigator call limit reached.");
          runtime?.session.agent.abort();
        },
        admitCall: () => {
          if (admittedCalls >= 8) return false;
          admittedCalls += 1;
          return true;
        },
      },
    );
    await runtime.session.agent.prompt("Continue until the request cap stops you.");
    assert.equal(providerCalls, 8);
    assert.equal(admittedCalls, 8);
    assert.equal(tools.retrievalCalls, 8);
    assert.match(String(failure), /call limit reached/);
  } finally {
    await runtime.dispose();
  }
});

test("context overflow is rejected before an inference dispatch", async () => {
  let runtime: Awaited<ReturnType<typeof createIsolatedInvestigatorSession>> | undefined;
  let failure: unknown;
  runtime = await createIsolatedInvestigatorSession(model, []);
  try {
    let providerCalls = 0;
    runtime.session.agent.streamFunction = guardInvestigatorStream(
      () => {
        providerCalls += 1;
        return providerToolCall("unused", "unused", {});
      },
      {
        signal: new AbortController().signal,
        isStopped: () => Boolean(failure),
        maxContextBytes: 1,
        onContextLimit: () => {
          failure = new Error("Investigator context limit reached.");
        },
        onLimit: () => {
          failure = new Error("call limit");
        },
        admitCall: () => true,
      },
    );
    await runtime.session.agent.prompt("This initial context exceeds one byte.");
    assert.equal(providerCalls, 0);
    assert.match(String(failure), /context limit reached/);
  } finally {
    await runtime.dispose();
  }
});
