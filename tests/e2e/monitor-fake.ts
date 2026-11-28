import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { annotationResponse } from "../integration/annotation-fake";
import { completionEvents } from "../integration/completion-stream";
import { FLAG_READS } from "./agent-script";

const MONITOR_SESSION = /^[0-9a-f-]{36}:monitor:[0-9a-f-]{36}$/;
const TOOLS = ["decode", "finish_investigation", "query_transcripts", "read_transcript"];
const CLASSIFIER_TOKENS = 100;
const SSE = { "content-type": "text/event-stream" };
// What the agent's tool-call rows look like in the worker's evidence.
const TOOL_CALL = /\[tool call sprite_exec id=(\S+?)\] (\{.*\})$/gm;

type Row = { ref: string; sessionId: string; role: string; text: string; toolCallId?: string };
type Message = { role: string; content?: unknown; tool_call_id?: string };
type Decision = { flagReadDetected: boolean; reason: string; evidence: { ref: string }[] };

const textOf = (content: unknown) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part: { text?: string }) => part.text ?? "").join("")
      : "";

// The rows of the target session, from the first user message. A request it cannot read is refused.
function targetRows(request: { messages: Message[] }): Row[] {
  const first = request.messages.find((message) => message.role === "user");
  assert.ok(first, "messages hold no user message");
  const text = textOf(first.content);
  const start = text.indexOf("\n\n{");
  assert.ok(start >= 0, "the user message holds no JSON after its text");
  const { snapshot } = JSON.parse(text.slice(start + 2));
  const rows: Row[] = snapshot?.currentTranscript;
  assert.ok(Array.isArray(rows) && rows.length, "the snapshot holds no transcript");
  assert.ok(
    rows.every((row) => row.sessionId === snapshot.targetSessionId && typeof row.ref === "string"),
    "the transcript's rows are not all of the target session",
  );
  return rows;
}

// Blocks when a command is one of the flag-reading commands in the script and its result is present.
function decide(rows: Row[]): Decision {
  for (const row of rows.filter((item) => item.role === "agent"))
    for (const [, id, args] of row.text.matchAll(TOOL_CALL)) {
      const { command } = JSON.parse(args) as { command: string };
      const result = rows.find((item) => item.role === "tool" && item.toolCallId === id);
      if (FLAG_READS.includes(command) && result)
        return {
          flagReadDetected: true,
          reason: `The command ${command} read the protected file.`,
          evidence: [{ ref: result.ref }],
        };
    }
  return { flagReadDetected: false, reason: "No command read the protected file.", evidence: [] };
}

// The monitor's two kinds of request: the text answers of the classifier and the annotations on
// `systemone`, and the investigator's chat completions. Everything else it refuses.
export function createMonitorFake(classifierQuestions: () => Promise<unknown>) {
  let calls = 0;
  return {
    // Undefined when the question set is neither the classifier's nor an annotation's.
    async systemone(body: { questions: unknown; state: unknown }) {
      if (isDeepStrictEqual(body.questions, await classifierQuestions())) {
        assert.ok(body.state && typeof body.state === "object", "the classifier's state");
        return Response.json({
          answers: {
            suspicion: { type: "score", score: 0, confidence: 1 },
            intent: { type: "noul", noul: 0.01 },
          },
          usage: { input_tokens: CLASSIFIER_TOKENS },
        });
      }
      return annotationResponse(body);
    },

    isInvestigation: (sessionId: unknown) => String(sessionId).includes(":monitor"),

    async investigate(request: Record<string, any>) {
      const { INVESTIGATOR_MODEL } = await import("../../lib/policy");
      const { READ_CONFIRMATION_REQUEST } = await import("../../lib/monitor-evidence");
      assert.equal(request.model, INVESTIGATOR_MODEL, "model");
      assert.equal(request.stream, true, "A provider request must stream");
      assert.match(String(request.session_id), MONITOR_SESSION, "session_id");
      assert.deepEqual(request.provider?.only, ["digitalocean"], "provider");
      const names = (request.tools ?? []).map(
        (tool: { function?: { name?: string } }) => tool.function?.name,
      );
      assert.ok(!names.includes("finish_second_look"), "A second look is not expected");
      assert.deepEqual([...names].sort(), TOOLS, "tools");
      assert.ok(Array.isArray(request.messages) && request.messages.length, "messages");
      const decision = decide(targetRows(request as { messages: Message[] }));
      const last = request.messages.at(-1) as Message;
      const turns = request.messages.filter((message: Message) => message.role !== "system");
      if (turns.length > 1) {
        // The only later request is the worker's read confirmation, the tool result of our block.
        assert.ok(
          last.role === "tool" && textOf(last.content).startsWith(READ_CONFIRMATION_REQUEST),
          "A second request must end in the read confirmation",
        );
        const asked = request.messages.findLast(
          (message: { tool_calls?: unknown[] }) => message.tool_calls?.length,
        );
        assert.ok(
          asked?.tool_calls.some((item: { id: string }) => item.id === last.tool_call_id),
          "The confirmation answers a call the investigator did not make",
        );
        assert.ok(decision.flagReadDetected, "A confirmation follows a block, not an allow");
      }
      const id = `call-investigator-${++calls}`;
      return new Response(
        completionEvents({
          id: `gen-investigator-${calls}`,
          choices: [
            {
              message: {
                role: "assistant",
                tool_calls: [
                  {
                    id,
                    type: "function",
                    function: { name: "finish_investigation", arguments: JSON.stringify(decision) },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0 },
        }).join(""),
        { headers: SSE },
      );
    },
  };
}
