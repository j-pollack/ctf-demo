import assert from "node:assert/strict";
import { test } from "node:test";
import { DISPLAY_NAME_QUESTIONS } from "../lib/display-name";
import { MODELS } from "../lib/policy";
import {
  INSTRUCTION_QUESTIONS,
  OUTPUT_QUESTIONS,
  SYSTEM_PROMPT_QUESTIONS,
} from "../lib/text-screen";
import { TYPESAFE_MODEL } from "../lib/typesafe";
import { AFTER_TOOL_TEXT, CONTINUE, KEYWORDS, REPLIES } from "./e2e/agent-script";
import { createOpenRouterFake } from "./e2e/openrouter-fake";

process.env.OPENROUTER_API_KEY = "openrouter-fake-test-key";
const SESSION = "00000000-0000-4000-8000-000000000001:agent";

const forwarded: string[] = [];
const fake = createOpenRouterFake({
  displayName: async (_url, init) => {
    forwarded.push(String(init?.body));
    return Response.json({ answers: {}, usage: { input_tokens: 1 } });
  },
});

const post = (body: unknown, over: { key?: string; signal?: AbortSignal } = {}) => ({
  method: "POST",
  headers: { authorization: `Bearer ${over.key ?? process.env.OPENROUTER_API_KEY}` },
  body: JSON.stringify(body),
  signal: over.signal,
});
const chat = (messages: unknown[], over: Record<string, unknown> = {}) => ({
  model: MODELS[0],
  stream: true,
  session_id: SESSION,
  messages,
  tools: [{ type: "function", function: { name: "sprite_exec" } }],
  ...over,
});
const user = (text: string) => ({ role: "user", content: text });
const URL_CHAT = "https://openrouter.ai/api/v1/chat/completions";
const URL_SCREEN = "https://openrouter.ai/api/v1/systemone";

async function chunks(response: Response) {
  const text = await response.text();
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
    .map((line) => JSON.parse(line.slice(6)));
}

test("the catalogue lists every model with what the app requires", async () => {
  const { data } = await (await fake.models("https://openrouter.ai/api/v1/models")).json();
  assert.deepEqual(data.map((entry: { id: string }) => entry.id).sort(), [...MODELS].sort());
  for (const entry of data) {
    assert.equal(entry.pricing.request, "0");
    assert.ok(Number(entry.pricing.prompt) > 0 && Number(entry.pricing.completion) > 0);
    assert.ok(entry.supported_parameters.includes("reasoning"));
    assert.ok(entry.supported_parameters.includes("tools"));
    assert.ok(entry.context_length > 0);
  }
});

test("the catalogue is read with GET only", async () => {
  await assert.rejects(
    () => fake.models("https://openrouter.ai/api/v1/models", { method: "POST" }),
    /GET/,
  );
});

test("a keyword that names a command is answered with text and a sprite_exec call", async () => {
  const response = await fake.completions(URL_CHAT, post(chat([user(`please ${KEYWORDS.list}`)])));
  const parts = await chunks(response);
  const delta = parts.flatMap((part) =>
    part.choices.map((choice: { delta: object }) => choice.delta),
  );
  const call = delta.find((item: { tool_calls?: unknown }) => item.tool_calls)?.tool_calls[0];
  assert.equal(call.function.name, "sprite_exec");
  assert.deepEqual(JSON.parse(call.function.arguments), { command: "ls /workspace" });
  assert.ok(delta.some((item: { content?: string }) => item.content));
  const usage = parts.find((part) => part.usage)?.usage;
  assert.ok(usage.cost > 0 && usage.cost < 0.01);
  assert.ok(Number.isFinite(usage.total_tokens));
});

test("the overspend keyword reports $0.60 and still issues a tool call", async () => {
  const parts = await chunks(
    await fake.completions(URL_CHAT, post(chat([user(KEYWORDS.overspend)]))),
  );
  assert.equal(parts.find((part) => part.usage).usage.cost, 0.6);
  assert.ok(JSON.stringify(parts).includes("tool_calls"));
});

test("a last message from a tool is answered with text and no tool call", async () => {
  const messages = [
    user(KEYWORDS.list),
    { role: "assistant", content: "x", tool_calls: [{ id: "c", type: "function" }] },
    { role: "tool", tool_call_id: "c", content: "notes.txt" },
  ];
  const parts = await chunks(await fake.completions(URL_CHAT, post(chat(messages))));
  assert.ok(JSON.stringify(parts).includes(AFTER_TOOL_TEXT));
  assert.ok(!JSON.stringify(parts).includes("tool_calls"));
});

test("system messages after the instruction do not hide it", async () => {
  const messages = [user(KEYWORDS.chat), { role: "system", content: "tools" }];
  const parts = await chunks(await fake.completions(URL_CHAT, post(chat(messages))));
  assert.ok(JSON.stringify(parts).includes(REPLIES[KEYWORDS.chat].text));
});

test("Continue. is answered as the last earlier user message that carried a keyword", async () => {
  const messages = [
    user(KEYWORDS.list),
    { role: "assistant", content: "x" },
    user("no keyword here"),
    { role: "assistant", content: "y" },
    user(`${KEYWORDS.chat} please`),
    { role: "assistant", content: "z" },
    user(CONTINUE),
  ];
  const parts = await chunks(await fake.completions(URL_CHAT, post(chat(messages))));
  assert.ok(JSON.stringify(parts).includes(REPLIES[KEYWORDS.chat].text));
  assert.ok(!JSON.stringify(parts).includes("tool_calls"));
});

test("Continue. with no earlier keyword is refused", async () => {
  await assert.rejects(
    () => fake.completions(URL_CHAT, post(chat([user("no keyword here"), user(CONTINUE)]))),
    /keyword/i,
  );
});

test("a request with no keyword, a wrong key, no stream, an unknown model or a bad session throws", async () => {
  const cases: [string, unknown][] = [
    ["keyword", post(chat([user("no keyword here")]))],
    ["authorization", post(chat([user(KEYWORDS.chat)]), { key: "wrong" })],
    ["stream", post(chat([user(KEYWORDS.chat)], { stream: false }))],
    ["catalogue", post(chat([user(KEYWORDS.chat)], { model: "other/model" }))],
    ["session_id", post(chat([user(KEYWORDS.chat)], { session_id: "abc" }))],
    ["last message", post(chat([{ role: "assistant", content: "x" }]))],
    ["tools", post(chat([user(KEYWORDS.chat)], { tools: [] }))],
  ];
  for (const [what, init] of cases)
    await assert.rejects(
      () => fake.completions(URL_CHAT, init as RequestInit),
      new RegExp(what, "i"),
      what,
    );
});

test("the hold keyword sends headers and no chunk until the request is aborted", async () => {
  const abort = new AbortController();
  const response = await fake.completions(
    URL_CHAT,
    post(chat([user(KEYWORDS.hold)]), { signal: abort.signal }),
  );
  const reader = response.body!.getReader();
  const first = reader.read();
  const raced = await Promise.race([
    first.then(() => "chunk"),
    new Promise((r) => setTimeout(() => r("held"), 100)),
  ]);
  assert.equal(raced, "held");
  abort.abort(new Error("stopped"));
  await assert.rejects(() => first, /stopped/);
});

test("text screens are scored, the jailbreak keyword scores a lose signal, other sets go elsewhere", async () => {
  const screen = (questions: unknown, state: unknown) =>
    fake.systemone(URL_SCREEN, post({ model: TYPESAFE_MODEL, state, questions }));
  const plain = await (await screen(INSTRUCTION_QUESTIONS, { text: "hello" })).json();
  assert.equal(plain.answers.overrides_rules.noul, 0.25);
  const flagged = await (
    await screen(INSTRUCTION_QUESTIONS, { text: `${KEYWORDS.jailbreak} now` })
  ).json();
  assert.equal(flagged.answers.overrides_rules.noul, 0.95);
  const output = await (await screen(OUTPUT_QUESTIONS, { output: KEYWORDS.jailbreak })).json();
  assert.equal(output.answers.overrides_rules.noul, 0.25);
  await screen(SYSTEM_PROMPT_QUESTIONS, { text: "be nice" });
  assert.deepEqual(forwarded, []);
  await screen(DISPLAY_NAME_QUESTIONS, { name: "plain_name" });
  assert.equal(forwarded.length, 1);
  await assert.rejects(
    () => screen({ other: { type: "noul", instructions: "x" } }, { text: "x" }),
    /question/i,
  );
});
