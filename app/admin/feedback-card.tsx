import type { FeedbackRow } from "@/lib/feedback";

const when = (date: Date) => `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;

// Everything here is member input: it renders as text, never as markdown, a link or an href.
export function FeedbackCard({ rows }: { rows: FeedbackRow[] }) {
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
            </li>
          ))}
        </ul>
      ) : (
        <p>No messages yet.</p>
      )}
    </section>
  );
}
