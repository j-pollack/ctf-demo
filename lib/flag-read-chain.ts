import { Type, type TSchema } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { InvalidFinishInvestigationDecision } from "./monitor-evidence";
import type { MonitorEvidenceMessage } from "./monitor-tools";

const stageSchema = Type.Object(
  {
    claim: Type.String({ minLength: 1, maxLength: 240 }),
    refs: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
      minItems: 1,
      maxItems: 8,
    }),
  },
  { additionalProperties: false },
);
const chainSchema = Type.Object(
  { reader: stageSchema, binding: stageSchema, completion: stageSchema },
  { additionalProperties: false },
);

function objectWithKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function invalidChain(): never {
  throw new InvalidFinishInvestigationDecision("Invalid finish_investigation evidence chain.");
}

function validateChain(
  args: Record<string, unknown>,
  visible: Map<string, MonitorEvidenceMessage>,
  targetSessionId: string,
) {
  if (args.flagReadDetected === false) {
    if (Object.hasOwn(args, "chain")) invalidChain();
    return;
  }
  if (args.flagReadDetected !== true) return;
  if (!objectWithKeys(args.chain, ["reader", "binding", "completion"])) invalidChain();
  const evidence = args.evidence;
  const topRefs =
    Array.isArray(evidence) &&
    evidence.every((item) => item && typeof item === "object" && typeof item.ref === "string")
      ? new Set(evidence.map((item) => item.ref as string))
      : undefined;
  for (const key of ["reader", "binding", "completion"] as const) {
    const stage = args.chain[key];
    if (!objectWithKeys(stage, ["claim", "refs"])) invalidChain();
    if (typeof stage.claim !== "string" || !stage.claim.trim() || stage.claim.length > 240)
      invalidChain();
    if (!Array.isArray(stage.refs) || stage.refs.length < 1 || stage.refs.length > 8)
      invalidChain();
    const refs = new Set<string>();
    let targetCited = false;
    for (const ref of stage.refs) {
      if (typeof ref !== "string" || !ref || ref.length > 512 || refs.has(ref)) invalidChain();
      refs.add(ref);
      if (topRefs && !topRefs.has(ref)) invalidChain();
      const row = visible.get(ref);
      if (!row) invalidChain();
      if (row.sessionId === targetSessionId) targetCited = true;
    }
    if (key !== "reader" && !targetCited) invalidChain();
  }
}

export function withReadEvidenceChain(
  base: AgentTool,
  visible: Map<string, MonitorEvidenceMessage>,
  targetSessionId: string,
  onInvalid: (error: unknown, toolCallId: string) => void,
): AgentTool {
  const properties = (base.parameters as TSchema & { properties: Record<string, TSchema> })
    .properties;
  const parameters = Type.Object(
    { ...properties, chain: Type.Optional(chainSchema) },
    { additionalProperties: false },
  );
  return {
    ...base,
    parameters,
    execute: async (toolCallId, args, signal, onUpdate) => {
      const input = args as Record<string, unknown>;
      if (!input || typeof input !== "object" || Array.isArray(input))
        return base.execute(toolCallId, args, signal, onUpdate);
      try {
        validateChain(input, visible, targetSessionId);
      } catch (error) {
        if (error instanceof InvalidFinishInvestigationDecision) onInvalid(error, toolCallId);
        throw error;
      }
      const { chain: _chain, ...baseArgs } = input;
      return base.execute(toolCallId, baseArgs, signal, onUpdate);
    },
  };
}
