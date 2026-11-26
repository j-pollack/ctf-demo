import type { FeedbackRow } from "@/lib/feedback";
import type { FeedbackState } from "@/lib/feedback-mail-text";

import { when } from "./when";

// Everything here is member input: it renders as text, never as markdown, a link or an href.
export function FeedbackCard({
  rows,
  states,
}: {
  rows: FeedbackRow[];
  states: Record<string, FeedbackState>;
}) {
  return (
    <section className="card wide">
      <header>
        <h2>Feedback</h2>
        <span>Newest {rows.length}</span>
      </header>
      {rows.length ? (
        <ul className="feedback">
          {rows.map((row) => (
            <li key={row.id}>
              <p>
                <strong>{row.kind}</strong> · {when(row.createdAt)} ·{" "}
                {row.kind === "contact"
                  ? `${row.name} <${row.email}>${row.accountEmail ? ` · account ${row.accountEmail}` : ""}`
                  : (row.accountEmail ?? "unknown account")}
              </p>
              {row.gameId && (
                <p>
                  Run {row.gameId}
                  {row.sessionId && ` · Session ${row.ordinal ?? "?"} ${row.sessionId}`}
                </p>
              )}
              <p className="feedback-message">{row.message}</p>
              <p>
                <a href={`/admin/feedback/${row.id}`}>Open thread</a>
                {states[row.id] && ` · ${states[row.id]}`}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p>No messages yet.</p>
      )}
    </section>
  );
}
