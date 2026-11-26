import { appendFileSync, writeSync } from "node:fs";
import { isMainThread, threadId } from "node:worker_threads";
import { createAccountFake } from "../integration/display-name-fake";
import { createFastmailFake } from "../integration/fastmail-fake";

type Entry = Record<string, unknown>;
// A fake external service: its answers, and every mail it has captured so far.
export type Fake = {
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  mail: () => Entry[];
};
export type GuardOptions = {
  real: typeof fetch;
  // The exact URLs that are faked, each with the fake that answers it.
  fakes: Record<string, Fake>;
  violation: (entry: Entry) => void;
  mail: (entry: Entry) => void;
};

function isLoopback(url: string) {
  if (!URL.canParse(url)) return false;
  const { protocol, hostname, username, password } = new URL(url);
  return protocol === "http:" && hostname === "127.0.0.1" && !username && !password;
}

// Loopback goes through, a faked URL goes to its fake, anything else rejects. Every rejection,
// including one a fake itself makes, leaves a violation for the runner.
export function guardedFetch(options: GuardOptions): typeof fetch {
  const captured = new Map<Fake, number>();
  const recordNewMail = (fake: Fake) => {
    const all = fake.mail();
    for (let i = captured.get(fake) ?? 0; i < all.length; i++) options.mail({ ...all[i] });
    captured.set(fake, all.length);
  };
  return async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (isLoopback(url)) return options.real(input, init);
    const fake = Object.hasOwn(options.fakes, url) ? options.fakes[url] : undefined;
    if (!fake) {
      options.violation({ kind: "unexpected-request", url });
      throw new Error(`Unexpected external request: ${url}`);
    }
    try {
      return await fake.fetch(input, init);
    } catch (error) {
      options.violation({
        kind: "fake-refused",
        url,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      recordNewMail(fake);
    }
  };
}

// Each submission the app sent through Fastmail, as the plain strings a journey reads.
export const fastmailFake = (fake: ReturnType<typeof createFastmailFake>): Fake => ({
  fetch: fake.fetch,
  mail: () =>
    fake.submissions.map(({ rcptTo, email }) => ({
      to: rcptTo[0],
      replyTo: email.replyTo[0] ?? "",
      subject: email.subject,
      text: email.text,
      messageId: email.messageId,
      inReplyTo: email.inReplyTo[0] ?? "",
      references: email.references,
    })),
});

export const leakedNames = (names: string[], env: Record<string, string | undefined>) =>
  names.filter((name) => env[name]);

const MARKER = Symbol.for("ctf.e2e.preload");
const globals = globalThis as typeof globalThis & { [MARKER]?: true };

// The guard is installed in every thread, once per thread, so a fetch from a worker thread is
// refused too. An earlier run showed this file evaluated twice in one process, and the marker keeps
// a second evaluation in the same thread from wrapping the first. The cause was not confirmed.
function install() {
  const violations = process.env.E2E_VIOLATIONS_FILE;
  const mail = process.env.E2E_MAIL_FILE;
  if (!violations || !mail) return;
  const installing = !globals[MARKER];
  // A synchronous write, because a worker thread's console output can be lost.
  const line = JSON.stringify({ event: "e2e.preload", isMainThread, threadId, installing });
  writeSync(1, `${line}\n`);
  if (!installing) return;
  globals[MARKER] = true;
  const append = (file: string) => (entry: Entry) =>
    appendFileSync(file, `${JSON.stringify(entry)}\n`);
  const record = append(violations);
  const reported = new Set<string>();
  const names = (process.env.E2E_EMPTY_NAMES ?? "").split(",").filter(Boolean);
  // Next loads its env files after this file, so the names are checked again on each request.
  const reportLeaks = () => {
    for (const name of leakedNames(names, process.env))
      if (!reported.has(name)) {
        reported.add(name);
        record({ kind: "name-not-empty", name });
      }
  };
  const account = createAccountFake();
  const accountFake: Fake = { fetch: account.fetch, mail: () => account.mail };
  const fastmail = fastmailFake(createFastmailFake());
  const guarded = guardedFetch({
    real: globalThis.fetch,
    fakes: {
      "https://api.resend.com/emails": accountFake,
      "https://openrouter.ai/api/v1/systemone": accountFake,
      "https://api.fastmail.com/jmap/session": fastmail,
      "https://api.fastmail.com/jmap/api/": fastmail,
    },
    violation: record,
    mail: append(mail),
  });
  reportLeaks();
  globalThis.fetch = (input, init) => {
    reportLeaks();
    return guarded(input, init);
  };
  globalThis.WebSocket = class {
    constructor() {
      throw new Error("Unexpected WebSocket connection.");
    }
  } as unknown as typeof WebSocket;
}

install();
