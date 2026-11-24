import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";

export type Mail = { to: string; subject: string; link: string };
// "answer" replies with scores; a number replies with that HTTP status; "hang" waits for the abort;
// "malformed" replies 200 with an out-of-range answer.
export type NameBehaviour = "answer" | "hang" | "malformed" | number;

// The two external boundaries this feature calls: Resend and Jev's System One endpoint for the
// display-name question set. Both validate their requests; any other request fails the test.
export function createAccountFake() {
  const mail: Mail[] = [];
  const names: string[] = [];
  const controls = {
    behave: (_name: string, _index: number): NameBehaviour => "answer",
    scores: (_name: string): Record<string, number> => ({}),
    tokens: 900,
    // Holds a Jev request, after it is logged, until the returned promise settles.
    hold: undefined as undefined | ((index: number) => Promise<void>),
    // A number makes Resend answer with that status; the email is still logged as attempted.
    mailStatus: 200,
    // Holds a Resend request, after it is logged, until the returned promise settles.
    mailHold: undefined as undefined | (() => Promise<void>),
  };
  const reset = () => {
    mail.length = 0;
    names.length = 0;
    controls.behave = () => "answer";
    controls.scores = () => ({});
    controls.tokens = 900;
    controls.hold = undefined;
    controls.mailStatus = 200;
    controls.mailHold = undefined;
  };
  // Account emails are sent after the response, so a test waits for them.
  const waitForMail = async (count: number) => {
    for (let i = 0; i < 200 && mail.length < count; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(mail.length, count, "expected email count");
    return mail;
  };
  const jev = async (init: RequestInit | undefined) => {
    const { DISPLAY_NAME_QUESTIONS } = await import("../../lib/display-name");
    const { TYPESAFE_MODEL } = await import("../../lib/typesafe");
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      `Bearer ${process.env.OPENROUTER_API_KEY}`,
    );
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(Object.keys(body).sort(), ["model", "questions", "state"]);
    assert.equal(body.model, TYPESAFE_MODEL);
    assert.ok(isDeepStrictEqual(body.questions, DISPLAY_NAME_QUESTIONS), "display-name-v1 only");
    assert.deepEqual(Object.keys(body.state), ["name"]);
    const name = body.state.name;
    assert.equal(typeof name, "string");
    const index = names.length;
    names.push(name);
    const behaviour = controls.behave(name, index);
    if (behaviour === "hang")
      await new Promise<never>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) return reject(signal.reason);
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    await controls.hold?.(index);
    if (typeof behaviour === "number")
      return new Response("fixture failure", { status: behaviour });
    if (behaviour === "malformed")
      return Response.json({
        answers: { offensive: { type: "noul", noul: 2 } },
        usage: { input_tokens: 5 },
      });
    const scores = controls.scores(name);
    return Response.json({
      answers: Object.fromEntries(
        Object.keys(DISPLAY_NAME_QUESTIONS).map((key) => [
          key,
          { type: "noul", noul: scores[key] ?? 0.05 },
        ]),
      ),
      usage: { input_tokens: controls.tokens },
    });
  };
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === "https://openrouter.ai/api/v1/systemone") return jev(init);
    assert.equal(url, "https://api.resend.com/emails", `Unexpected external request: ${url}`);
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      `Bearer ${process.env.RESEND_API_KEY}`,
    );
    const sent = JSON.parse(String(init?.body));
    assert.equal(sent.from, process.env.RESEND_FROM);
    const link = String(sent.text).match(/https?:\/\/\S+/)?.[0];
    assert.ok(link, "every email carries a link");
    mail.push({ to: String(sent.to), subject: String(sent.subject), link });
    await controls.mailHold?.();
    if (controls.mailStatus !== 200)
      return Response.json(
        {
          name: "internal_server_error",
          message: "fixture failure",
          statusCode: controls.mailStatus,
        },
        { status: controls.mailStatus },
      );
    return Response.json({ id: "synthetic-resend-id" });
  };
  return { mail, names, controls, reset, fetch, waitForMail };
}
