import { auth } from "./auth";
import { db } from "./db";
import { isAdmin } from "./admin";
import { isSafeAddress, mailConfig, readThreads, sendMail, type ThreadMail } from "./fastmail";
import { getFeedback, isUuid, type FeedbackRow } from "./feedback";
import { MESSAGE_MAX } from "./feedback-limits";
import {
  isNotification,
  notificationId,
  notificationSubject,
  replyBody,
  threadState,
  type FeedbackState,
} from "./feedback-mail-text";
import { GameError } from "./policy";

const STATES_TIMEOUT_MS = 3_000;
const NOT_SET_UP = "Email is not set up.";

type Options = { signal?: AbortSignal };
// Why a thread page shows only the stored message, when it does.
export type ThreadNote = "not-set-up" | "no-thread" | "unreadable";
export type ThreadMessage = {
  from: string;
  at: Date;
  text: string;
  ours: boolean;
  truncated: boolean;
  htmlOnly: boolean;
};
export type FeedbackThread = {
  row: FeedbackRow;
  note: ThreadNote | null;
  messages: ThreadMessage[];
};

function logFailure(event: string, error: unknown) {
  // Errors from the mail client name the failure only: no token, address or body.
  console.error(
    JSON.stringify({ event, error: error instanceof Error ? error.message : String(error) }),
  );
}

async function requireAdmin(headers: Headers) {
  const session = await auth.api.getSession({ headers });
  if (!isAdmin(session?.user)) throw new GameError("Not found.", 404);
}

// A typed address for a contact message, the member's account address for a report.
const senderOf = (row: FeedbackRow) => (row.kind === "contact" ? row.email : row.accountEmail);

function notificationText(row: FeedbackRow, unsafeSender: string | null) {
  const run = row.sessionId ? `\nSession: ${row.sessionId}` : "";
  const details = row.kind === "contact" ? "" : `\n\nRun: ${row.gameId}${run}`;
  // An address the client refuses cannot go in a header, so the operators get it as text.
  const sender = unsafeSender ? `\n\nSender address: ${unsafeSender}` : "";
  return `${row.message}${details}${sender}`;
}

async function storeThread(id: string, threadId: string) {
  await db.query("UPDATE ctf.feedback SET mail_thread_id=$2 WHERE id=$1", [id, threadId]);
}

// Never throws: a failure is logged and the row keeps a null thread.
export async function notifyFeedback(id: string, { signal }: Options = {}) {
  try {
    const config = mailConfig();
    if (!config) return;
    const row = await getFeedback(id);
    const sender = row && senderOf(row);
    if (!row || !sender) return;
    const safe = isSafeAddress(sender);
    const { threadId } = await sendMail(
      {
        to: config.address,
        ...(safe && { replyTo: sender }),
        subject: notificationSubject(row),
        text: notificationText(row, safe ? null : sender),
        messageId: notificationId(row.id, config.address),
      },
      { signal },
    );
    await storeThread(row.id, threadId);
  } catch (error) {
    logFailure("feedback_mail.notify_failed", error);
  }
}

const storedMessage = (row: FeedbackRow): ThreadMessage => ({
  from: senderOf(row) ?? "unknown",
  at: row.createdAt,
  text: row.message,
  ours: false,
  truncated: false,
  htmlOnly: false,
});

const toMessage = (mail: ThreadMail): ThreadMessage => ({
  from: mail.from,
  at: mail.receivedAt,
  text: mail.text ?? "",
  ours: mail.sent,
  truncated: mail.truncated ?? false,
  htmlOnly: mail.htmlOnly ?? false,
});

export async function feedbackThread(headers: Headers, id: string, { signal }: Options = {}) {
  await requireAdmin(headers);
  const row = await getFeedback(id);
  if (!row) return null;
  const only = (note: ThreadNote): FeedbackThread => ({
    row,
    note,
    messages: [storedMessage(row)],
  });
  const config = mailConfig();
  if (!config) return only("not-set-up");
  if (!row.mailThreadId) return only("no-thread");
  try {
    const mails = (await readThreads([row.mailThreadId], { bodies: true }, { signal })).get(
      row.mailThreadId,
    );
    return {
      row,
      note: null,
      messages: [
        storedMessage(row),
        ...(mails ?? []).filter((mail) => !isNotification(mail, row.id)).map(toMessage),
      ],
    } satisfies FeedbackThread;
  } catch (error) {
    logFailure("feedback_mail.read_failed", error);
    return only("unreadable");
  }
}

function replyText(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  // Postgres cannot store a NUL, and Fastmail would reject one in a body.
  if (!text || text.length > MESSAGE_MAX || text.includes("\u0000"))
    throw new GameError("Enter a valid reply.");
  return text;
}

export async function replyToFeedback(
  headers: Headers,
  id: string,
  value: unknown,
  { signal }: Options = {},
) {
  await requireAdmin(headers);
  const config = mailConfig();
  if (!config) throw new GameError(NOT_SET_UP);
  const text = replyText(value);
  const row = await getFeedback(id);
  if (!row) throw new GameError("Not found.", 404);
  const to = senderOf(row);
  if (!to) throw new GameError("This message has no address to reply to.");
  const mails = row.mailThreadId
    ? ((await readThreads([row.mailThreadId], { bodies: false }, { signal })).get(
        row.mailThreadId,
      ) ?? [])
    : [];
  // The notification is ours too, so only an earlier reply counts as already quoting.
  const answered = mails.some((mail) => mail.sent && !isNotification(mail, row.id));
  const ids = mails.flatMap((mail) => (mail.messageId ? [mail.messageId] : []));
  const { threadId } = await sendMail(
    {
      to,
      subject: `Re: ${notificationSubject(row)}`,
      text: replyBody(text, row.message, !answered),
      ...(ids.length && { inReplyTo: ids.at(-1), references: [...new Set(ids)] }),
    },
    { signal },
  );
  // A stored thread with no visible mail is replaced, as a row with no thread is given one.
  if (!mails.length) await storeThread(row.id, threadId);
}

export async function setFeedbackClosed(headers: Headers, id: string, closed: boolean) {
  await requireAdmin(headers);
  if (!isUuid(id)) throw new GameError("Not found.", 404);
  const { rowCount } = await db.query(
    `UPDATE ctf.feedback SET closed_at=CASE WHEN $2 THEN coalesce(closed_at,now()) END WHERE id=$1`,
    [id, closed],
  );
  if (!rowCount) throw new GameError("Not found.", 404);
}

// Called only from the admin page, after its admin check, with rows from listFeedback.
// A row Fastmail could not answer for has no entry.
export async function feedbackStates(
  rows: FeedbackRow[],
  { signal = AbortSignal.timeout(STATES_TIMEOUT_MS) }: Options = {},
) {
  const config = mailConfig();
  const open = rows.filter((row) => row.mailThreadId && !row.closedAt);
  let threads = new Map<string, ThreadMail[]>();
  if (config && open.length)
    try {
      threads = await readThreads(
        open.map((row) => row.mailThreadId!),
        { bodies: false },
        { signal },
      );
    } catch (error) {
      logFailure("feedback_mail.states_failed", error);
    }
  const states: Record<string, FeedbackState> = {};
  for (const row of rows) {
    if (row.closedAt) states[row.id] = "closed";
    else if (!row.mailThreadId) states[row.id] = "waiting";
    else if (config && threads.has(row.mailThreadId))
      states[row.id] = threadState(threads.get(row.mailThreadId)!, row.id);
  }
  return states;
}
