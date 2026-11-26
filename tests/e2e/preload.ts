import { appendFileSync, writeSync } from "node:fs";
import { isMainThread, threadId } from "node:worker_threads";
import { createAccountFake } from "../integration/display-name-fake";

type Fake = Pick<ReturnType<typeof createAccountFake>, "fetch" | "mail">;
type Entry = Record<string, unknown>;
export type GuardOptions = {
  real: typeof fetch;
  fake: Fake;
  violation: (entry: Entry) => void;
  mail: (entry: Entry) => void;
};

// The two hosts the faked account boundary answers. Everything else off this machine is refused.
const FAKED_URLS = new Set([
  "https://api.resend.com/emails",
  "https://openrouter.ai/api/v1/systemone",
]);

function isLoopback(url: string) {
  if (!URL.canParse(url)) return false;
  const { protocol, hostname, username, password } = new URL(url);
  return protocol === "http:" && hostname === "127.0.0.1" && !username && !password;
}

// Loopback goes through, Resend and the display-name check go to the fake, anything else rejects.
// Every rejection, including one the fake itself makes, leaves a violation for the runner.
export function guardedFetch(options: GuardOptions): typeof fetch {
  let captured = 0;
  const recordNewMail = () => {
    for (; captured < options.fake.mail.length; captured++)
      options.mail({ ...options.fake.mail[captured] });
  };
  return async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (isLoopback(url)) return options.real(input, init);
    if (!FAKED_URLS.has(url)) {
      options.violation({ kind: "unexpected-request", url });
      throw new Error(`Unexpected external request: ${url}`);
    }
    try {
      return await options.fake.fetch(input, init);
    } catch (error) {
      options.violation({
        kind: "fake-refused",
        url,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      recordNewMail();
    }
  };
}

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
  const guarded = guardedFetch({
    real: globalThis.fetch,
    fake: createAccountFake(),
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
