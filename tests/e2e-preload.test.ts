import assert from "node:assert/strict";
import { test } from "node:test";
import { DISPLAY_NAME_QUESTIONS } from "../lib/display-name";
import { TYPESAFE_MODEL } from "../lib/typesafe";
import { createAccountFake } from "./integration/display-name-fake";
import { guardedFetch, leakedNames } from "./e2e/preload";

process.env.RESEND_API_KEY = "preload-test-resend";
process.env.RESEND_FROM = "preload@example.invalid";
process.env.OPENROUTER_API_KEY = "preload-test-router";

function setup() {
  const seen: string[] = [];
  const violations: Record<string, unknown>[] = [];
  const mail: Record<string, unknown>[] = [];
  const fake = createAccountFake();
  const real = (async (input: string | URL | Request) => {
    seen.push(String(input));
    return new Response("real");
  }) as typeof fetch;
  const guarded = guardedFetch({
    real,
    fake,
    violation: (entry) => violations.push(entry),
    mail: (entry) => mail.push(entry),
  });
  return { seen, violations, mail, guarded };
}
const resend = (text: string, to = "member@example.invalid") => ({
  method: "POST",
  headers: { authorization: "Bearer preload-test-resend", "content-type": "application/json" },
  body: JSON.stringify({ from: "preload@example.invalid", to, subject: "Hello", text }),
});

test("E2: loopback over http reaches the real fetch", async () => {
  const { seen, violations, guarded } = setup();
  assert.equal(await (await guarded("http://127.0.0.1:3000/api/leaderboard")).text(), "real");
  assert.deepEqual(seen, ["http://127.0.0.1:3000/api/leaderboard"]);
  assert.deepEqual(violations, []);
});

test("E2: another host, a lookalike host, userinfo and https loopback reject and are recorded", async () => {
  const urls = [
    "https://example.com/x",
    "http://127.0.0.1.evil.test/",
    "http://user:pw@127.0.0.1:3000/",
    "https://127.0.0.1/",
    "not a url",
  ];
  for (const url of urls) {
    const { seen, violations, guarded } = setup();
    await assert.rejects(() => guarded(url), /Unexpected external request/, url);
    assert.deepEqual(seen, [], url);
    assert.equal(violations.length, 1, url);
    assert.equal(violations[0].url, url);
  }
});

test("E2: a Request object is judged by its URL", async () => {
  const { violations, guarded } = setup();
  await assert.rejects(() => guarded(new Request("https://example.com/y")), /Unexpected/);
  assert.equal(violations[0].url, "https://example.com/y");
});

test("Resend goes to the fake and each captured mail is recorded once", async () => {
  const { seen, violations, mail, guarded } = setup();
  const url = "https://api.resend.com/emails";
  assert.equal(
    (await guarded(url, resend("Open http://127.0.0.1:3000/verify?token=a"))).status,
    200,
  );
  assert.equal(
    (await guarded(url, resend("Open http://127.0.0.1:3000/verify?token=b", "b@example.invalid")))
      .status,
    200,
  );
  assert.deepEqual(seen, []);
  assert.deepEqual(violations, []);
  assert.deepEqual(
    mail.map((entry) => [entry.to, entry.link]),
    [
      ["member@example.invalid", "http://127.0.0.1:3000/verify?token=a"],
      ["b@example.invalid", "http://127.0.0.1:3000/verify?token=b"],
    ],
  );
});

test("E2: a request the fake itself refuses is recorded and rejected", async () => {
  const { violations, guarded } = setup();
  await assert.rejects(() => guarded("https://api.resend.com/emails", resend("no link here")));
  assert.equal(violations.length, 1);
  assert.equal(violations[0].url, "https://api.resend.com/emails");
  assert.match(String(violations[0].message), /link/);
});

test("the display-name check goes to the fake and the model catalogue is refused", async () => {
  const { violations, guarded } = setup();
  const answer = await guarded("https://openrouter.ai/api/v1/systemone", {
    method: "POST",
    headers: { authorization: "Bearer preload-test-router" },
    body: JSON.stringify({
      model: TYPESAFE_MODEL,
      state: { name: "plain_name" },
      questions: DISPLAY_NAME_QUESTIONS,
    }),
  });
  assert.equal(answer.status, 200);
  assert.equal(violations.length, 0);
  await assert.rejects(() => guarded("https://openrouter.ai/api/v1/models"), /Unexpected/);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].url, "https://openrouter.ai/api/v1/models");
});

test("E1: only names that carry a value are reported as leaked", () => {
  assert.deepEqual(
    leakedNames(["SITE_URL", "ADMIN_EMAILS", "CONTACT_EMAIL"], {
      SITE_URL: "https://x",
      ADMIN_EMAILS: "",
    }),
    ["SITE_URL"],
  );
});
