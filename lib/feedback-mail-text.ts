// The pure parts of the feedback mail: subjects, the derived Message-ID, quoting and states.
import type { ThreadMail } from "./fastmail";

export type FeedbackState = "closed" | "answered" | "waiting";
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const RUN_PREFIX = 8;

export function notificationSubject(row: {
  kind: string;
  name: string | null;
  gameId: string | null;
}) {
  const subject =
    row.kind === "contact"
      ? `[CTF] Contact from ${row.name}`
      : `[CTF] Report (${row.kind}) on run ${row.gameId?.slice(0, RUN_PREFIX)}`;
  return subject.replace(CONTROL, " ");
}

// Derived, not stored: the row id and the contact domain are enough to find it again.
export function notificationId(rowId: string, contact: string) {
  return `${notificationPrefix(rowId)}${contact.split("@")[1]}`;
}

export function replyBody(text: string, stored: string, quote: boolean) {
  if (!quote) return text;
  const quoted = stored
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `${text}\n\nYou wrote:\n${quoted}`;
}

// The notification is found by this prefix alone, so moving CONTACT_EMAIL does not turn a
// notification sent from the old address into a reply.
export const notificationPrefix = (rowId: string) => `feedback-${rowId}@`;

export const isNotification = (mail: ThreadMail, rowId: string) =>
  mail.messageId?.startsWith(notificationPrefix(rowId)) ?? false;

// `mails` is in time order and includes the notification, which is ours but not an answer.
export function threadState(mails: ThreadMail[], rowId: string): "answered" | "waiting" {
  const newest = mails.filter((mail) => !isNotification(mail, rowId)).at(-1);
  return newest?.sent ? "answered" : "waiting";
}
