import { MESSAGE_MAX } from "@/lib/feedback-limits";
import type { FeedbackThread, ThreadNote } from "@/lib/feedback-mail";
import { FeedbackStatus } from "../../feedback-status";
import { when } from "../../when";
import { ReplyButton } from "./reply-button";

const NOTES: Record<ThreadNote, string> = {
  "not-set-up": "Email is not set up.",
  "no-thread": "There is no email thread for this message yet.",
  unreadable: "The email thread could not be read.",
};
const ERRORS = {
  reply: "The reply was not sent. Check it and try again.",
  close: "The status was not changed. Try again.",
};

// Everything from mail is untrusted: it renders as text, never as markdown, a link or an href.
export function FeedbackThreadView({
  thread: { row, note, messages },
  error,
  reply,
  close,
}: {
  thread: FeedbackThread;
  error?: keyof typeof ERRORS;
  reply: (data: FormData) => Promise<void>;
  close: (data: FormData) => Promise<void>;
}) {
  const closed = row.closedAt !== null;
  const answered = messages.length > 1 && messages.at(-1)!.ours;
  return (
    <>
      <a className="back-link" href="/admin#inbox" data-testid="feedback-thread-back">
        Back to inbox
      </a>
      <section className="card thread">
        <header className="thread-head">
          <h2>{row.kind === "contact" ? "Contact message" : `Report: ${row.kind}`}</h2>
          <FeedbackStatus
            state={closed ? "closed" : answered ? "answered" : "waiting"}
            data-testid="feedback-thread-state"
          />
          <form action={close}>
            <input type="hidden" name="id" value={row.id} />
            <input type="hidden" name="closed" value={closed ? "off" : "on"} />
            <button data-testid="feedback-thread-toggle">
              {closed ? "Reopen ticket" : "Close ticket"}
            </button>
          </form>
        </header>
        <p>
          {when(row.createdAt)} ·{" "}
          {row.kind === "contact" ? (
            <>
              {row.name} &lt;{row.email}&gt; <small>unverified</small>
            </>
          ) : (
            (row.accountEmail ?? "unknown account")
          )}
        </p>
        {row.gameId && (
          <p>
            Run {row.gameId}
            {row.sessionId && ` · Session ${row.ordinal ?? "?"} ${row.sessionId}`}
          </p>
        )}
        {note && <p>{NOTES[note]}</p>}
        {error && (
          <p role="alert" className="field-error" data-testid="feedback-thread-error">
            {ERRORS[error]}
          </p>
        )}
        <ul className="messages">
          {messages.map((message, index) => (
            <li
              key={index}
              data-testid="feedback-thread-entry"
              data-state={message.ours ? "ours" : "theirs"}
            >
              <p>
                <strong>{message.from}</strong> · {message.ours ? "ours" : "theirs"} ·{" "}
                {when(message.at)}
              </p>
              <p className="feedback-message">{message.text}</p>
              {message.htmlOnly && <p>HTML message, open it in Fastmail.</p>}
              {message.truncated && <p>This message is truncated. Open it in Fastmail.</p>}
            </li>
          ))}
        </ul>
        {note !== "not-set-up" && (
          <form action={reply} className="reply-form">
            <input type="hidden" name="id" value={row.id} />
            <label htmlFor="reply-text">Reply</label>
            <textarea
              id="reply-text"
              name="text"
              rows={8}
              required
              maxLength={MESSAGE_MAX}
              data-testid="feedback-thread-reply"
            />
            <ReplyButton />
          </form>
        )}
      </section>
    </>
  );
}
