// Child-process worker for the drain tests: the shared worker preload, with an investigator reply
// that is held until the test creates the control file named by HELD_REVIEW_RELEASE_FILE.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import "./async-worker-preload";
import { streamedCompletion } from "./completion-stream";

const inner = globalThis.fetch;
const release = process.env.HELD_REVIEW_RELEASE_FILE ?? "";
globalThis.fetch = async (input: string | URL | Request, options?: RequestInit) => {
  if (String(input) !== "https://openrouter.ai/api/v1/chat/completions")
    return inner(input, options);
  // Validated before the hold, as the shared preload validates its replies.
  assert.equal(options?.method, "POST");
  assert.equal(new Headers(options.headers).get("authorization"), "Bearer integration-router-key");
  assert.equal(JSON.parse(String(options.body)).model, "z-ai/glm-5.3");
  assert.equal(JSON.parse(String(options.body)).stream, true);
  while (!existsSync(release)) {
    options?.signal?.throwIfAborted();
    await delay(25);
  }
  return streamedCompletion(options, {
    id: "held-review",
    choices: [
      {
        message: {
          tool_calls: [
            {
              id: "held-finish",
              type: "function",
              function: {
                name: "finish_investigation",
                arguments: JSON.stringify({
                  flagReadDetected: false,
                  reason: "No evidenced read.",
                  evidence: [],
                }),
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0 },
  });
};
