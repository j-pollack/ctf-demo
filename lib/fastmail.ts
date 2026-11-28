// A small JMAP client (RFC 8620, 8621) for the contact mailbox. Plain fetch, one deadline per
// operation, nothing cached between operations. Errors name the failure, never an address or body.
const SESSION_URL = "https://api.fastmail.com/jmap/session";
const MAIL = "urn:ietf:params:jmap:mail";
const USING = ["urn:ietf:params:jmap:core", MAIL, "urn:ietf:params:jmap:submission"];
const SENDER_NAME = "Capture the flag";
const DEFAULT_TIMEOUT_MS = 10_000;
const BODY_MAX_BYTES = 20_000;
// Nothing here has a meaning in a mail header: no comma, semicolon, angle bracket, quote,
// parenthesis, colon, backslash, space or non-ASCII character.
const SAFE_ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/;
const HIDDEN_ROLES = ["drafts", "junk", "trash"];

export class FastmailError extends Error {}

type Json = any;
type Call = [string, Json, string];
type Session = { apiUrl: string; accountId: string; signal: AbortSignal };
type Options = { signal?: AbortSignal };

export type OutgoingMail = {
  to: string;
  replyTo?: string;
  subject: string;
  text: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
};
export type ThreadMail = {
  // Null when the email has none, so it is never offered as a reply target.
  messageId: string | null;
  from: string;
  receivedAt: Date;
  sent: boolean;
  text?: string;
  truncated?: boolean;
  htmlOnly?: boolean;
};

export function mailConfig() {
  const token = process.env.FASTMAIL_API_TOKEN;
  const address = process.env.CONTACT_EMAIL;
  return token && address ? { token, address } : null;
}

function configured() {
  const config = mailConfig();
  if (!config) throw new FastmailError("Email is not set up.");
  return config;
}

async function fetchJson(url: string, init: RequestInit, token: string, signal: AbortSignal) {
  const response = await fetch(url, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${token}` },
    signal,
  });
  if (response.status !== 200) throw new FastmailError(`Fastmail answered ${response.status}.`);
  try {
    return await response.json();
  } catch {
    throw new FastmailError("Fastmail answered with malformed JSON.");
  }
}

async function openSession(token: string, signal: AbortSignal): Promise<Session> {
  const session = await fetchJson(SESSION_URL, {}, token, signal);
  const accountId = session?.primaryAccounts?.[MAIL];
  if (typeof session?.apiUrl !== "string" || typeof accountId !== "string")
    throw new FastmailError("Fastmail session has no mail account.");
  return { apiUrl: session.apiUrl, accountId, signal };
}

// Returns each method's result by call id. A method error is kept as an error value, so one failed
// call does not hide the others; need() throws it when the caller reads that call.
async function invoke(session: Session, token: string, calls: Call[]) {
  const body = await fetchJson(
    session.apiUrl,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ using: USING, methodCalls: calls }),
    },
    token,
    session.signal,
  );
  if (!Array.isArray(body?.methodResponses))
    throw new FastmailError("Fastmail answered without method responses.");
  // A call can have more than one response under its id: a submission with onSuccessUpdateEmail is
  // followed by an implicit Email/set. The call's own response or error comes first and is the one
  // that counts, so a later error from the implicit step cannot undo a send that succeeded.
  const named = new Map(calls.map(([name, , callId]) => [callId, name]));
  const results: Record<string, Json> = {};
  for (const [name, result, callId] of body.methodResponses) {
    if (callId in results) continue;
    if (name === "error")
      results[callId] = new FastmailError(`Fastmail method error ${result?.type}.`);
    else if (name === named.get(callId)) results[callId] = result;
  }
  return results;
}

function need(results: Record<string, Json>, callId: string) {
  const result = results[callId];
  if (result instanceof FastmailError) throw result;
  if (!result) throw new FastmailError("Fastmail left out a response.");
  return result;
}

export const isSafeAddress = (address: string) => SAFE_ADDRESS.test(address);

function requireSafe(address: string) {
  if (!isSafeAddress(address)) throw new FastmailError("Address has a character not allowed.");
}

const roleIds = (mailboxes: Json[]) =>
  Object.fromEntries(mailboxes.map((box) => [box.role, box.id])) as Record<string, string>;

export async function sendMail(mail: OutgoingMail, { signal }: Options = {}) {
  const { token, address } = configured();
  for (const value of [address, mail.to, mail.replyTo ?? address]) requireSafe(value);
  const session = await openSession(token, signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS));
  const { accountId } = session;
  const setup = await invoke(session, token, [
    ["Mailbox/get", { accountId, properties: ["id", "role"] }, "m"],
    ["Identity/get", { accountId, properties: ["id", "email"] }, "i"],
  ]);
  const roles = roleIds(need(setup, "m").list);
  const identity = need(setup, "i").list.find(
    (entry: Json) => String(entry.email).toLowerCase() === address.toLowerCase(),
  );
  if (!roles.drafts || !roles.sent || !identity)
    throw new FastmailError("Fastmail has no drafts, sent or identity for the contact address.");

  const draft = {
    mailboxIds: { [roles.drafts]: true },
    keywords: { $draft: true },
    from: [{ name: SENDER_NAME, email: address }],
    to: [{ email: mail.to }],
    ...(mail.replyTo && { replyTo: [{ email: mail.replyTo }] }),
    subject: mail.subject,
    bodyValues: { body: { value: mail.text } },
    textBody: [{ partId: "body", type: "text/plain" }],
    ...(mail.messageId && { "header:Message-ID:asMessageIds": [mail.messageId] }),
    // The plain properties, not the header form: Fastmail refuses the header form of In-Reply-To
    // for a long id (63 characters was refused), and a sender's mail client often makes such ids.
    ...(mail.inReplyTo && { inReplyTo: [mail.inReplyTo] }),
    ...(mail.references?.length && { references: mail.references }),
  };
  const sent = await invoke(session, token, [
    ["Email/set", { accountId, create: { draft } }, "e"],
    [
      "EmailSubmission/set",
      {
        accountId,
        create: {
          send: {
            identityId: identity.id,
            emailId: "#draft",
            envelope: { mailFrom: { email: address }, rcptTo: [{ email: mail.to }] },
          },
        },
        onSuccessUpdateEmail: {
          "#send": {
            [`mailboxIds/${roles.drafts}`]: null,
            [`mailboxIds/${roles.sent}`]: true,
            "keywords/$draft": null,
          },
        },
      },
      "s",
    ],
  ]);
  const email = need(sent, "e");
  const created = email.created?.draft;
  if (!created)
    throw new FastmailError(`Fastmail did not create the email: ${email.notCreated?.draft?.type}.`);
  try {
    const submission = need(sent, "s");
    if (!submission.created?.send)
      throw new FastmailError(
        `Fastmail did not submit the email: ${submission.notCreated?.send?.type}.`,
      );
  } catch (error) {
    // A leftover draft is hidden by the draft filter in readThreads, so a failed cleanup is not fatal.
    await invoke(session, token, [["Email/set", { accountId, destroy: [created.id] }, "d"]]).catch(
      () => undefined,
    );
    throw error;
  }
  return { threadId: String(created.threadId) };
}

function bodyOf(email: Json) {
  const plain: Json[] = (email.textBody ?? []).filter((part: Json) => part.type === "text/plain");
  if (!plain.length) return { text: "", htmlOnly: true };
  const values = plain.map((part) => email.bodyValues?.[part.partId]);
  return {
    text: values.map((value) => value?.value ?? "").join("\n"),
    truncated: values.some((value) => value?.isTruncated),
  };
}

export async function readThreads(
  threadIds: string[],
  { bodies }: { bodies: boolean },
  { signal }: Options = {},
) {
  const { token } = configured();
  const session = await openSession(token, signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS));
  const { accountId } = session;
  const properties = [
    "id",
    "threadId",
    "mailboxIds",
    "keywords",
    "messageId",
    "from",
    "receivedAt",
  ];
  const result = await invoke(session, token, [
    ["Mailbox/get", { accountId, properties: ["id", "role"] }, "mb"],
    ["Thread/get", { accountId, ids: threadIds }, "t"],
    [
      "Email/get",
      {
        accountId,
        "#ids": { resultOf: "t", name: "Thread/get", path: "/list/*/emailIds" },
        properties: bodies ? [...properties, "textBody", "bodyValues"] : properties,
        fetchTextBodyValues: bodies,
        maxBodyValueBytes: BODY_MAX_BYTES,
      },
      "e",
    ],
  ]);
  const role = new Map<string, string>(
    need(result, "mb").list.map((box: Json) => [box.id, box.role]),
  );
  need(result, "t");
  const byThread = new Map<string, Map<string, ThreadMail>>(threadIds.map((id) => [id, new Map()]));
  for (const email of need(result, "e").list as Json[]) {
    const roles = Object.keys(email.mailboxIds).map((id) => role.get(id));
    if (email.keywords?.$draft || roles.some((value) => HIDDEN_ROLES.includes(value!))) continue;
    const messageId: string | null = email.messageId?.[0] ?? null;
    const key = messageId ?? email.id;
    const sent = roles.includes("sent");
    const copies = byThread.get(email.threadId);
    // The same message can sit in Sent and the Inbox: show it once, as ours.
    if (!copies || (copies.has(key) && !sent)) continue;
    copies.set(key, {
      messageId,
      from: email.from?.[0]?.email ?? "",
      receivedAt: new Date(email.receivedAt),
      sent,
      ...(bodies && bodyOf(email)),
    });
  }
  return new Map(
    [...byThread].map(([id, copies]) => [
      id,
      [...copies.values()].sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime()),
    ]),
  );
}
