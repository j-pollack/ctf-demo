import assert from "node:assert/strict";

// The one external boundary this feature calls: Fastmail's JMAP API. The fake validates every
// request against what the app is meant to send, keeps mailboxes and mail in memory, and records
// each violation so a test fails even when the app swallows the error it caused.
type Json = any;
export type Role = "inbox" | "drafts" | "sent" | "junk" | "trash";
// "hang" waits for the abort after the session answered.
export type Failure =
  | "session-500"
  | "api-500"
  | "malformed"
  | "method-error"
  | "email-not-created"
  | "submission-not-created"
  | "submission-method-error"
  | "submission-missing"
  | "hang";
export type FakeEmail = {
  id: string;
  threadId: string;
  mailboxIds: Record<string, true>;
  keywords: Record<string, true>;
  messageId: string;
  from: string;
  fromName?: string;
  to: string[];
  replyTo: string[];
  subject: string;
  text: string;
  html: boolean;
  // With html set: the message also has a plain text part.
  plainToo?: boolean;
  inReplyTo: string[];
  references: string[];
  receivedAt: string;
};
export type Seed = {
  from: string;
  mailbox: Role;
  text?: string;
  html?: boolean;
  plainToo?: boolean;
  inReplyTo?: string[];
  // null seeds an email with no Message-ID header, an empty from seeds one with no From.
  messageId?: string | null;
  threadId?: string;
  keywords?: string[];
};

const SESSION_URL = "https://api.fastmail.com/jmap/session";
const API_URL = "https://api.fastmail.com/jmap/api/";
const ACCOUNT = "account-1";
const IDENTITY = "identity-1";
const ROLES: Role[] = ["inbox", "drafts", "sent", "junk", "trash"];
const USING = [
  "urn:ietf:params:jmap:core",
  "urn:ietf:params:jmap:mail",
  "urn:ietf:params:jmap:submission",
];
const SHAPES = new Set([
  "Mailbox/get,Identity/get",
  "Email/set,EmailSubmission/set",
  "Email/set",
  "Mailbox/get,Thread/get,Email/get",
]);
const EMAIL_PROPERTIES = [
  "id",
  "threadId",
  "mailboxIds",
  "keywords",
  "messageId",
  "from",
  "receivedAt",
];
const BODY_PROPERTIES = ["textBody", "bodyValues"];
// The only header form the app may use. Real Fastmail refuses a long id in the header form of
// In-Reply-To, so reply threading must go through the plain inReplyTo and references properties.
const HEADERS = new Set(["header:Message-ID:asMessageIds"]);
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const MESSAGE_ID_MAX = 64;
const ID_ROLES = Object.fromEntries(ROLES.map((role) => [role, `mailbox-${role}`])) as Record<
  Role,
  string
>;

export function createFastmailFake() {
  const emails: FakeEmail[] = [];
  const requests: string[] = [];
  const violations: string[] = [];
  const submissions: { mailFrom: string; rcptTo: string[]; email: FakeEmail }[] = [];
  const controls = {
    fail: undefined as Failure | undefined,
    // The submission succeeds, then the implicit Email/set that files the email answers with an error.
    implicitError: false,
    // Holds a request, after it is logged, until the returned promise settles.
    hold: undefined as undefined | (() => Promise<void>),
  };
  let clock = 0;
  let counter = 0;
  const reset = () => {
    emails.length = 0;
    requests.length = 0;
    submissions.length = 0;
    controls.fail = undefined;
    controls.implicitError = false;
    controls.hold = undefined;
  };
  // Deliberate failures (a hang the test asked for) are not violations; every other error thrown
  // while handling a request is, whether it came from bad() or from an assertion.
  const deliberate = new WeakSet<object>();
  const bad = (message: string): never => {
    throw new Error(`Fastmail fake: ${message}`);
  };
  const contact = () => process.env.CONTACT_EMAIL!;
  const known = (id: unknown, kind: string, allowed: string[]) => {
    if (typeof id !== "string" || !allowed.includes(id))
      bad(`${kind} ${String(id)} not handed out`);
  };
  const nextId = (prefix: string) => `${prefix}-${++counter}`;
  const receivedAt = () => new Date(Date.UTC(2026, 10, 26, 12, 0, ++clock)).toISOString();

  const insert = (
    email: Omit<FakeEmail, "id" | "receivedAt" | "threadId"> & { threadId?: string },
  ) => {
    const parent = email.inReplyTo
      .map((id) => emails.find((other) => other.messageId === id))
      .find(Boolean);
    const stored: FakeEmail = {
      ...email,
      id: nextId("email"),
      threadId: email.threadId ?? parent?.threadId ?? nextId("thread"),
      receivedAt: receivedAt(),
    };
    emails.push(stored);
    return stored;
  };
  const seed = (options: Seed) =>
    insert({
      mailboxIds: { [ID_ROLES[options.mailbox]]: true },
      keywords: Object.fromEntries((options.keywords ?? []).map((key) => [key, true])),
      messageId:
        options.messageId === null ? "" : (options.messageId ?? `${nextId("seed")}@sender.invalid`),
      from: options.from,
      to: [contact()],
      replyTo: [],
      subject: "seeded",
      text: options.text ?? "seeded text",
      html: options.html ?? false,
      plainToo: options.plainToo,
      inReplyTo: options.inReplyTo ?? [],
      references: [],
      threadId: options.threadId,
    });

  const addresses = (value: Json, field: string, named = false) => {
    if (!Array.isArray(value) || !value.length) bad(`${field} must be a list of addresses`);
    return (value as Json[]).map((entry) => {
      if (!entry || typeof entry !== "object") return bad(`${field} entry must be an object`);
      const keys = named ? ["name", "email"] : ["email"];
      assert.deepEqual(Object.keys(entry), keys, `${field} entries are { ${keys.join(", ")} }`);
      if (named && (typeof entry.name !== "string" || !entry.name || CONTROL.test(entry.name)))
        bad(`${field} name must be a plain string`);
      return String(entry.email);
    });
  };
  const messageIds = (value: Json, field: string) => {
    if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || /[<>\s]/.test(id)))
      bad(`${field} must be an array of Message-IDs without angle brackets`);
    return value as string[];
  };

  const createDraft = (args: Json) => {
    if (args.accountId !== ACCOUNT) bad("accountId");
    assert.deepEqual(Object.keys(args.create ?? {}), ["draft"], "one draft per call");
    const draft = args.create.draft;
    const allowed = new Set([
      "mailboxIds",
      "keywords",
      "from",
      "to",
      "replyTo",
      "subject",
      "bodyValues",
      "textBody",
      "inReplyTo",
      "references",
      ...HEADERS,
    ]);
    for (const key of Object.keys(draft))
      if (!allowed.has(key)) bad(`unexpected draft property ${key}`);
    assert.deepEqual(draft.mailboxIds, { [ID_ROLES.drafts]: true }, "draft goes to Drafts");
    assert.deepEqual(draft.keywords, { $draft: true }, "draft is keyworded");
    assert.deepEqual(draft.textBody, [{ partId: "body", type: "text/plain" }]);
    const text = draft.bodyValues?.body?.value;
    if (typeof text !== "string") bad("bodyValues.body.value");
    if (typeof draft.subject !== "string" || CONTROL.test(draft.subject))
      bad("subject has a control character");
    const from = addresses(draft.from, "from", true);
    const to = addresses(draft.to, "to");
    const replyTo = draft.replyTo === undefined ? [] : addresses(draft.replyTo, "replyTo");
    if (from.length !== 1 || to.length !== 1) bad("one from and one to");
    if (replyTo.length > 1) bad("at most one replyTo");
    const header = (name: string) =>
      draft[name] === undefined ? [] : messageIds(draft[name], name);
    const own = header("header:Message-ID:asMessageIds");
    if (own.length > 1) bad("one Message-ID");
    return insert({
      mailboxIds: { [ID_ROLES.drafts]: true },
      keywords: { $draft: true },
      messageId: own[0] ?? `${nextId("generated")}@fastmail.invalid`,
      from: from[0],
      fromName: draft.from[0].name,
      to,
      replyTo,
      subject: draft.subject,
      text: text as string,
      html: false,
      inReplyTo: header("inReplyTo"),
      references: header("references"),
    });
  };

  const submit = (args: Json, draft: FakeEmail | undefined) => {
    if (args.accountId !== ACCOUNT) bad("accountId");
    assert.deepEqual(Object.keys(args.create ?? {}), ["send"], "one submission per call");
    const send = args.create.send;
    known(send.identityId, "identity", [IDENTITY]);
    assert.equal(send.emailId, "#draft", "the submission references the draft by creation id");
    const { mailFrom, rcptTo } = send.envelope ?? {};
    assert.deepEqual(Object.keys(mailFrom ?? {}), ["email"]);
    assert.equal(mailFrom.email, contact(), "envelope sender is the contact address");
    if (!Array.isArray(rcptTo) || rcptTo.length !== 1) bad("exactly one envelope recipient");
    assert.deepEqual(Object.keys(rcptTo[0]), ["email"]);
    assert.deepEqual(args.onSuccessUpdateEmail, {
      "#send": {
        [`mailboxIds/${ID_ROLES.drafts}`]: null,
        [`mailboxIds/${ID_ROLES.sent}`]: true,
        "keywords/$draft": null,
      },
    });
    if (!draft || controls.fail === "submission-not-created")
      return { notCreated: { send: { type: draft ? "forbiddenToSend" : "invalidProperties" } } };
    delete draft.mailboxIds[ID_ROLES.drafts];
    draft.mailboxIds[ID_ROLES.sent] = true;
    delete draft.keywords.$draft;
    const recipient: string = rcptTo[0].email;
    submissions.push({ mailFrom: mailFrom.email, rcptTo: [recipient], email: { ...draft } });
    // A message sent to the contact address also lands in the Inbox, with the same Message-ID.
    if (recipient.toLowerCase() === contact().toLowerCase())
      insert({ ...draft, mailboxIds: { [ID_ROLES.inbox]: true }, threadId: draft.threadId });
    return { created: { send: { id: nextId("submission") } } };
  };

  const view = (email: FakeEmail, args: Json) => {
    const full: Record<string, unknown> = {
      id: email.id,
      threadId: email.threadId,
      mailboxIds: email.mailboxIds,
      keywords: email.keywords,
      messageId: email.messageId ? [email.messageId] : null,
      from: email.from ? [{ name: email.fromName ?? null, email: email.from }] : null,
      receivedAt: email.receivedAt,
      textBody: [
        ...(!email.html || email.plainToo ? [{ partId: "text", type: "text/plain" }] : []),
        ...(email.html ? [{ partId: "html", type: "text/html" }] : []),
      ],
      bodyValues: args.fetchTextBodyValues
        ? {
            text: {
              value: Buffer.from(email.text).subarray(0, args.maxBodyValueBytes).toString(),
              isTruncated: Buffer.byteLength(email.text) > args.maxBodyValueBytes,
            },
            html: { value: "<p>html</p>", isTruncated: false },
          }
        : {},
    };
    return Object.fromEntries(args.properties.map((name: string) => [name, full[name]]));
  };

  const methods = (calls: Json[]) => {
    const results = new Map<string, Json>();
    const created = new Map<string, FakeEmail>();
    const out = calls.flatMap(([name, args, callId]) => {
      let result: Json;
      if (controls.fail === "method-error" && results.size === 0) result = null;
      else if (name === "Mailbox/get") {
        if (args.accountId !== ACCOUNT) bad("accountId");
        result = { list: ROLES.map((role) => ({ id: ID_ROLES[role], role, name: role })) };
      } else if (name === "Identity/get") {
        if (args.accountId !== ACCOUNT) bad("accountId");
        result = { list: [{ id: IDENTITY, email: contact() }] };
      } else if (name === "Email/set" && args.create) {
        // Real Fastmail refuses a Message-ID longer than 64 characters, as its header line would
        // pass 78. Found with the real account; a shorter id in the smoke check had hidden it.
        const own = args.create?.draft?.["header:Message-ID:asMessageIds"]?.[0];
        if (controls.fail === "email-not-created" || (own && own.length > MESSAGE_ID_MAX))
          result = { notCreated: { draft: { type: "invalidProperties" } } };
        else {
          const draft = createDraft(args);
          created.set("#draft", draft);
          result = {
            created: {
              draft: { id: draft.id, blobId: "blob", threadId: draft.threadId, size: 1 },
            },
          };
        }
      } else if (name === "Email/set") {
        assert.deepEqual(Object.keys(args), ["accountId", "destroy"]);
        for (const id of args.destroy) {
          const index = emails.findIndex((email) => email.id === id);
          if (index < 0) bad(`destroy of unknown email ${id}`);
          emails.splice(index, 1);
        }
        result = { destroyed: args.destroy };
      } else if (name === "EmailSubmission/set") {
        if (controls.fail === "submission-missing") return [];
        result =
          controls.fail === "submission-method-error"
            ? null
            : submit(args, created.get(args.create?.send?.emailId));
      } else if (name === "Thread/get") {
        if (args.accountId !== ACCOUNT) bad("accountId");
        if (!Array.isArray(args.ids)) bad("Thread/get ids");
        const list = (args.ids as string[]).flatMap((id) => {
          const members = emails.filter((email) => email.threadId === id);
          return members.length ? [{ id, emailIds: members.map((email) => email.id) }] : [];
        });
        result = { list, notFound: [] };
      } else if (name === "Email/get") {
        if (args.accountId !== ACCOUNT) bad("accountId");
        assert.deepEqual(args["#ids"], {
          resultOf: "t",
          name: "Thread/get",
          path: "/list/*/emailIds",
        });
        const wanted = new Set(results.get("t").list.flatMap((t: Json) => t.emailIds));
        const body = args.fetchTextBodyValues === true;
        assert.deepEqual(
          args.properties,
          body ? [...EMAIL_PROPERTIES, ...BODY_PROPERTIES] : EMAIL_PROPERTIES,
        );
        if (body) assert.equal(args.maxBodyValueBytes, 20000);
        result = {
          list: emails.filter((email) => wanted.has(email.id)).map((email) => view(email, args)),
        };
      } else return bad(`unexpected method ${name}`);
      results.set(callId, result);
      if (result === null) return [["error", { type: "serverFail" }, callId]];
      const response = [name, { accountId: ACCOUNT, ...result }, callId];
      // RFC 8621 section 7.5: a successful onSuccessUpdateEmail makes the server run an implicit
      // Email/set and return its response after the submission's, under the same call id.
      const implicit =
        name === "EmailSubmission/set" && result.created && args.onSuccessUpdateEmail
          ? [
              controls.implicitError
                ? ["error", { type: "serverFail" }, callId]
                : [
                    "Email/set",
                    {
                      accountId: ACCOUNT,
                      updated: { [created.get(args.create.send.emailId)!.id]: null },
                      notUpdated: null,
                    },
                    callId,
                  ],
            ]
          : [];
      return [response, ...implicit];
    });
    return { methodResponses: out };
  };

  const api = async (init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    assert.deepEqual(body.using, USING, "exact capability list");
    const shape = body.methodCalls.map((call: Json) => call[0]).join(",");
    if (!SHAPES.has(shape)) bad(`unexpected request ${shape}`);
    if (controls.fail === "api-500") return new Response("fixture failure", { status: 500 });
    if (controls.fail === "malformed") return new Response("not json", { status: 200 });
    if (controls.fail === "hang")
      await new Promise<never>((_resolve, reject) => {
        const signal = init.signal;
        const abort = () => {
          deliberate.add(signal!.reason);
          reject(signal!.reason);
        };
        if (signal?.aborted) return abort();
        signal?.addEventListener("abort", abort, { once: true });
      });
    return Response.json(methods(body.methodCalls));
  };

  const handle = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    requests.push(url);
    const headers = new Headers(init.headers);
    if (url !== SESSION_URL && url !== API_URL) bad(`Unexpected external request: ${url}`);
    if (headers.get("authorization") !== `Bearer ${process.env.FASTMAIL_API_TOKEN}`)
      bad("missing or wrong bearer token");
    if (!init.signal) bad("every request carries a deadline");
    if (url === SESSION_URL) {
      if ((init.method ?? "GET") !== "GET") bad("the session is a GET");
      await controls.hold?.();
      if (controls.fail === "session-500") return new Response("fixture failure", { status: 500 });
      return Response.json({
        apiUrl: API_URL,
        primaryAccounts: { "urn:ietf:params:jmap:mail": ACCOUNT },
      });
    }
    if (init.method !== "POST") bad("the API is a POST");
    return api(init);
  };

  const fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    try {
      return await handle(input, init);
    } catch (error) {
      if (!deliberate.has(error as object))
        violations.push(error instanceof Error ? error.message : String(error));
      throw error;
    }
  };

  return {
    fetch,
    reset,
    seed,
    emails,
    requests,
    violations,
    submissions,
    controls,
    mailboxId: (role: Role) => ID_ROLES[role],
  };
}
