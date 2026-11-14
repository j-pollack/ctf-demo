import assert from "node:assert/strict";
import { test } from "node:test";
import { createFinishInvestigationTool, type FlagReadDecision } from "../lib/monitor-evidence";
import { withReadEvidenceChain } from "../lib/flag-read-chain";
import type { MonitorEvidenceMessage } from "../lib/monitor-tools";

const target: MonitorEvidenceMessage = {
  ref: "msg:target:2",
  sessionId: "target",
  index: 2,
  role: "tool",
  text: "Completed report.",
  sha256: "target-hash",
  chunkIndex: 0,
  chunkCount: 1,
};
const history: MonitorEvidenceMessage = {
  ...target,
  ref: "msg:history:1",
  sessionId: "history",
  text: "Reader source.",
  sha256: "history-hash",
};
const visible = new Map([target, history].map((row) => [row.ref, row]));

function setup() {
  const decisions: FlagReadDecision[] = [];
  const failed: unknown[] = [];
  const invalid: string[] = [];
  const base = createFinishInvestigationTool(
    visible,
    target.sessionId,
    (decision) => decisions.push(decision),
    (error) => failed.push(error),
    (_error, id) => invalid.push(id),
  );
  const tool = withReadEvidenceChain(base, visible, target.sessionId, (_error, id) =>
    invalid.push(id),
  );
  const execute = (id: string, args: unknown) =>
    tool.execute(id, args as never, undefined, undefined, {} as never);
  return { base, tool, decisions, failed, invalid, execute };
}

const positive = {
  flagReadDetected: true,
  reason: "The executed reader consumed the protected file.",
  evidence: [{ ref: history.ref }, { ref: target.ref }],
};
const stage = (refs: string[]) => ({ claim: "Observed source and completion.", refs });
const chain = {
  reader: stage([history.ref]),
  binding: stage([target.ref]),
  completion: stage([target.ref]),
};

test("evidence-chain schema changes only the selected finish tool and positive requires all links", async () => {
  const { base, tool, execute, decisions, invalid, failed } = setup();
  assert.equal(tool.name, base.name);
  assert.equal(tool.executionMode, base.executionMode);
  const baseSchema = base.parameters as typeof base.parameters & {
    properties: Record<string, unknown>;
    required: string[];
  };
  const selectedSchema = tool.parameters as typeof tool.parameters & {
    properties: Record<string, unknown>;
    required: string[];
  };
  assert.deepEqual(Object.keys(baseSchema.properties), ["flagReadDetected", "reason", "evidence"]);
  assert.deepEqual(Object.keys(selectedSchema.properties), [
    "flagReadDetected",
    "reason",
    "evidence",
    "chain",
  ]);
  assert.deepEqual(selectedSchema.required, baseSchema.required);
  await assert.rejects(execute("missing", positive), /chain/i);
  await assert.rejects(
    execute("missing-stage", { ...positive, chain: { reader: chain.reader } }),
    /chain/i,
  );
  await execute("valid", { ...positive, chain });
  assert.deepEqual(invalid, ["missing", "missing-stage"]);
  assert.deepEqual(failed, []);
  assert.deepEqual(decisions, [
    {
      ...positive,
      investigationComplete: true,
      evidence: [
        { ref: history.ref, excerpt: history.text, sha256: history.sha256 },
        { ref: target.ref, excerpt: target.text, sha256: target.sha256 },
      ],
    },
  ]);
});

test("chain bounds, membership, target anchors and negative omission remain recoverable", async () => {
  const { execute, decisions, failed, invalid } = setup();
  const invalidChains = [
    { ...chain, reader: { ...chain.reader, claim: "  " } },
    { ...chain, reader: { ...chain.reader, claim: "x".repeat(241) } },
    { ...chain, reader: { ...chain.reader, refs: [] } },
    { ...chain, reader: { ...chain.reader, refs: Array(9).fill(history.ref) } },
    { ...chain, reader: { ...chain.reader, refs: [history.ref, history.ref] } },
    { ...chain, reader: { ...chain.reader, refs: ["missing"] } },
    { ...chain, reader: { ...chain.reader, refs: ["r".repeat(513)] } },
    { ...chain, reader: { ...chain.reader, refs: [""] } },
    { ...chain, binding: stage([history.ref]) },
    { ...chain, completion: stage([history.ref]) },
    { ...chain, extra: stage([target.ref]) },
    { ...chain, reader: { ...chain.reader, extra: true } },
  ];
  for (const [index, candidate] of invalidChains.entries())
    await assert.rejects(execute(`invalid-${index}`, { ...positive, chain: candidate }), /chain/i);
  await assert.rejects(
    execute("not-in-top", {
      ...positive,
      evidence: [{ ref: history.ref }],
      chain,
    }),
    /chain/i,
  );
  await assert.rejects(
    execute("negative-chain", { ...positive, flagReadDetected: false, chain }),
    /chain/i,
  );
  await execute("negative", {
    flagReadDetected: false,
    reason: "No completed read is established.",
    evidence: [],
  });
  assert.equal(invalid.length, invalidChains.length + 2);
  assert.deepEqual(failed, []);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].flagReadDetected, false);
});

test("wrapper preserves base validation, source objects and execution arguments", async () => {
  const { base, tool, execute, decisions, invalid, failed } = setup();
  const schemaBefore = structuredClone(base.parameters);
  const args = structuredClone({ ...positive, chain });
  await execute("valid", args);
  assert.deepEqual(args, { ...positive, chain });
  assert.deepEqual(base.parameters, schemaBefore);
  await assert.rejects(execute("base-invalid", { ...positive, reason: " ", chain }), /reason/i);
  await assert.rejects(
    execute("base-unknown", { ...positive, chain, unexpected: true }),
    /arguments/i,
  );
  assert.deepEqual(invalid, ["base-invalid", "base-unknown"]);
  assert.deepEqual(failed, []);
  assert.equal(decisions.length, 1);
  const signal = new AbortController().signal;
  const update = () => {};
  const context = {} as Parameters<typeof tool.execute>[4];
  const forwarded: unknown[] = [];
  const spyBase = {
    ...base,
    execute: async (...params: Parameters<typeof base.execute>) => {
      forwarded.push(...params);
      return { content: [{ type: "text" as const, text: "forwarded" }], details: {} };
    },
  };
  const spyTool = withReadEvidenceChain(spyBase, visible, target.sessionId, () =>
    assert.fail("valid chain must not notify invalid"),
  );
  await spyTool.execute("forward", args as never, signal, update, context);
  assert.deepEqual(forwarded, ["forward", positive, signal, update, context]);
});

test("structurally valid chains do not claim to prove semantic entailment", async () => {
  const { execute, decisions, invalid } = setup();
  await execute("unsupported-claim", {
    ...positive,
    chain: {
      reader: { claim: "A claim not entailed by the cited text.", refs: [target.ref] },
      binding: stage([target.ref]),
      completion: stage([target.ref]),
    },
  });
  assert.deepEqual(invalid, []);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].flagReadDetected, true);
});

test("base finish callback failure propagates once without wrapper invalid notification", async () => {
  const sentinel = new Error("finish callback failed");
  const failures: unknown[] = [];
  const invalid: unknown[] = [];
  const base = createFinishInvestigationTool(
    visible,
    target.sessionId,
    () => {
      throw sentinel;
    },
    (error) => failures.push(error),
    (error) => invalid.push(error),
  );
  const tool = withReadEvidenceChain(base, visible, target.sessionId, (error) =>
    invalid.push(error),
  );
  await assert.rejects(
    tool.execute("callback", { ...positive, chain } as never, undefined, undefined, {} as never),
    (error) => error === sentinel,
  );
  assert.deepEqual(failures, [sentinel]);
  assert.deepEqual(invalid, []);
});
