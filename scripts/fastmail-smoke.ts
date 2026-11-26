// Opt-in live check of the Fastmail contract behind the fake in tests/integration/fastmail-fake.ts.
// Never run in CI. It needs a real FASTMAIL_API_TOKEN and CONTACT_EMAIL in .env.local.
//   npm run smoke:fastmail -- send <outside address>
//     sends the notification and then a reply to the outside address, built as replyToFeedback
//     builds it, and prints the thread id. Reply to that mail from the outside account.
//   npm run smoke:fastmail -- read <thread id>
//     checks the thread once the outside reply has arrived.
// The outside address must not be on this Fastmail account: a reply from inside it also has a
// copy in Sent, so it would look like ours.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isSafeAddress, sendMail } from "../lib/fastmail";
import { NOTIFICATION_MARK, notificationId, replyBody } from "../lib/feedback-mail-text";

const SUBJECT = "[CTF] Smoke check";
const token = process.env.FASTMAIL_API_TOKEN;
const contact = process.env.CONTACT_EMAIL;
assert.ok(token && contact, "Set FASTMAIL_API_TOKEN and CONTACT_EMAIL in .env.local.");
const headers = { Authorization: `Bearer ${token}` };

// Calls are built from the account id, which the session supplies.
async function jmap(calls: (accountId: string) => unknown[]) {
  const session = await (await fetch("https://api.fastmail.com/jmap/session", { headers })).json();
  const accountId = session.primaryAccounts["urn:ietf:params:jmap:mail"] as string;
  const response = await fetch(session.apiUrl, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
      methodCalls: calls(accountId),
    }),
  });
  const body = await response.json();
  assert.ok(Array.isArray(body.methodResponses), "Fastmail answered without method responses.");
  return Object.fromEntries(
    body.methodResponses.map(([, result, id]: [string, unknown, string]) => [id, result]),
  ) as Record<string, any>;
}

async function send(outside: string | undefined) {
  assert.ok(outside && isSafeAddress(outside), "Usage: send <outside address>");
  assert.notEqual(
    outside.toLowerCase(),
    contact!.toLowerCase(),
    "The outside address must not be the contact address.",
  );
  // A random row id, so the Message-ID has the length a real notification's has.
  const messageId = notificationId(randomUUID(), contact!);
  const note = await sendMail({
    to: contact!,
    replyTo: outside,
    subject: SUBJECT,
    text: "Smoke check message.",
    messageId,
  });
  await sendMail({
    to: outside,
    subject: `Re: ${SUBJECT}`,
    text: replyBody(
      "Smoke check reply. Reply to this mail from this account.",
      "Smoke check message.",
      true,
    ),
    inReplyTo: messageId,
    references: [messageId],
  });
  console.log(
    `Thread ${note.threadId}. Reply to the mail sent to ${outside} from that account, then run: read ${note.threadId}`,
  );
}

async function read(threadId: string | undefined) {
  assert.ok(threadId, "Usage: read <thread id>");
  const results = await jmap((accountId) => [
    ["Mailbox/get", { accountId, properties: ["id", "role"] }, "m"],
    ["Thread/get", { accountId, ids: [threadId] }, "t"],
    [
      "Email/get",
      {
        accountId,
        "#ids": { resultOf: "t", name: "Thread/get", path: "/list/*/emailIds" },
        properties: ["mailboxIds", "messageId", "from"],
      },
      "e",
    ],
  ]);
  const role = new Map<string, string>(results.m.list.map((box: any) => [box.id, box.role]));
  const drafts = results.m.list.find((box: any) => box.role === "drafts").id;
  const inRole = (email: any, wanted: string) =>
    Object.keys(email.mailboxIds).some((box) => role.get(box) === wanted);
  const emails: any[] = results.e?.list ?? [];
  const notification = (email: any) => String(email.messageId?.[0]).startsWith(NOTIFICATION_MARK);
  const fromContact = (email: any) => email.from?.[0]?.email === contact;
  assert.ok(
    emails.some((email) => notification(email) && inRole(email, "inbox")),
    "The notification has no Inbox copy with the derived Message-ID.",
  );
  assert.ok(
    emails.some((email) => notification(email) && inRole(email, "sent")),
    "The notification has no Sent copy with the derived Message-ID.",
  );
  assert.ok(
    emails.some((email) => !notification(email) && fromContact(email) && inRole(email, "sent")),
    "The app reply's Sent copy is not in the notification's thread.",
  );
  const outside = emails.filter((email) => !fromContact(email));
  assert.ok(
    outside.length > 0 && outside.every((email) => !inRole(email, "sent")),
    "No outside reply joined the notification's thread, or it has a copy in Sent. The reply must come from an account that is not on this Fastmail account.",
  );
  const left = await jmap((accountId) => [
    ["Email/query", { accountId, filter: { inMailbox: drafts, text: SUBJECT } }, "q"],
  ]);
  assert.equal(left.q.ids.length, 0, "Drafts holds a message from this run.");
  console.log("The Fastmail contract holds: copies, thread, Message-ID and outside reply.");
}

const [phase, argument] = process.argv.slice(2);
if (phase === "send") await send(argument);
else if (phase === "read") await read(argument);
else throw new Error("Usage: send <outside address> | read <thread id>");
