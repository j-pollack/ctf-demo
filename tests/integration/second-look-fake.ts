import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SECOND_LOOK_PROMPT } from "../../lib/second-look";
import { streamedCompletion } from "./completion-stream";

export type SecondLookRequest = { kind: string; text: string; effort: unknown; at: number };
// "clear" and "jailbreak" answer through the tool; "invalid" answers with text and no call; "cut"
// is cut off at the output limit; a number replies with that HTTP status.
export type SecondLookBehaviour = "clear" | "jailbreak" | "invalid" | "cut" | number;

// The OpenRouter boundary's branch for a second look: the one request that offers only
// `finish_second_look`. It validates the request as strictly as the investigator's branch, and a
// text that was not declared by the scenario fails the request.
export function createSecondLookFake(issue: (id: string) => void) {
  const requests: SecondLookRequest[] = [];
  const controls = {
    // The texts a scenario expects to be judged. Any other text fails the request.
    expected: new Set<string>(),
    behave: (_text: string): SecondLookBehaviour => "clear",
    // Holds every request, after it is logged, for this long. An abort ends the hold.
    delayMs: 0,
    // Holds every request until this many have arrived, which proves they were sent at once.
    barrier: 0,
    // Runs just before a request is answered.
    beforeAnswer: undefined as undefined | ((text: string) => Promise<void>),
    // The reasoning effort every request must carry.
    effort: "high",
  };
  const reset = () => {
    requests.length = 0;
    controls.expected = new Set();
    controls.behave = () => "clear";
    controls.delayMs = 0;
    controls.barrier = 0;
    controls.beforeAnswer = undefined;
    controls.effort = "high";
  };
  const held = (ms: number, signal?: AbortSignal | null) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  const isSecondLook = (payload: { tools?: { function: { name: string } }[] }) =>
    payload.tools?.some((tool) => tool.function.name === "finish_second_look") ?? false;
  const response = async (payload: Record<string, any>, options: RequestInit) => {
    assert.deepEqual(
      payload.tools.map((tool: { function: { name: string } }) => tool.function.name),
      ["finish_second_look"],
      "a second look offers only its own tool",
    );
    const { properties } = payload.tools[0].function.parameters;
    assert.deepEqual(Object.keys(properties).sort(), ["jailbreak", "reason"]);
    assert.equal(payload.stream, true);
    assert.equal(payload.max_tokens, 2048);
    assert.equal(payload.reasoning?.effort, controls.effort);
    assert.equal(payload.model, "z-ai/glm-5.3");
    assert.equal(payload.messages.length, 2);
    const [system, user] = payload.messages;
    assert.deepEqual([system.role, user.role], ["system", "user"]);
    assert.equal(system.content, SECOND_LOOK_PROMPT);
    const data = JSON.parse(user.content);
    assert.deepEqual(Object.keys(data), ["kind", "text"]);
    assert.ok(["instruction", "system_prompt"].includes(data.kind));
    assert.ok(controls.expected.has(data.text), "Unexpected text under judgment");
    assert.ok(!system.content.includes(data.text), "the text is not part of the instructions");
    requests.push({
      kind: data.kind,
      text: data.text,
      effort: payload.reasoning?.effort,
      at: performance.now(),
    });
    if (controls.barrier) while (requests.length < controls.barrier) await held(20, options.signal);
    if (controls.delayMs) await held(controls.delayMs, options.signal);
    const behaviour = controls.behave(data.text);
    await controls.beforeAnswer?.(data.text);
    if (typeof behaviour === "number")
      return Response.json(
        { error: { code: behaviour, message: "fixture" } },
        { status: behaviour },
      );
    const answer = (jailbreak: boolean) => ({
      tool_calls: [
        {
          id: randomUUID(),
          type: "function",
          function: {
            name: "finish_second_look",
            arguments: JSON.stringify({ jailbreak, reason: `Judged ${jailbreak}.` }),
          },
        },
      ],
    });
    const message =
      behaviour === "invalid"
        ? { content: "I will not use the tool." }
        : behaviour === "cut"
          ? { reasoning: "Cut off." }
          : answer(behaviour === "jailbreak");
    const id = `test-${randomUUID()}`;
    issue(id);
    return streamedCompletion(
      options,
      {
        id,
        choices: [
          {
            message,
            finish_reason:
              behaviour === "cut" ? "length" : "tool_calls" in message ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0 },
      },
      { split: true },
    );
  };
  return { requests, controls, reset, isSecondLook, response };
}
