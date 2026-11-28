import type { FeedbackRow } from "@/lib/feedback";
import type { FeedbackState } from "@/lib/feedback-mail-text";

import { FeedbackStatus } from "./feedback-status";
import { when } from "./when";

const KINDS: Record<string, string> = {
  contact: "Contact form",
  bug: "Bug report",
  monitor: "Monitor report",
  other: "Report",
};
const pageHref = (page: number) => `/admin?inbox=${page}#inbox`;

// Everything here is member input: it renders as text, never as markdown, a link or an href.
export function FeedbackCard({
  rows,
  states,
  page,
  more,
}: {
  rows: FeedbackRow[];
  states: Record<string, FeedbackState>;
  page: number;
  more: boolean;
}) {
  return (
    <section id="inbox" className="admin-section" aria-labelledby="inbox-title">
      <header className="section-head">
        <h2 id="inbox-title">Inbox</h2>
        <span>Open first, then newest</span>
      </header>
      {rows.length ? (
        <ul className="card inbox">
          {rows.map((row) => {
            const state = states[row.id] ?? (row.closedAt ? "closed" : "open");
            return (
              <li key={row.id} data-testid="admin-feedback-row" data-state={state}>
                <FeedbackStatus state={state} />
                <div className="inbox-body">
                  <p>
                    <strong>
                      {row.kind === "contact" ? row.name : (row.accountEmail ?? "unknown account")}
                    </strong>
                    {row.kind === "contact" && <small> &lt;{row.email}&gt;</small>}
                  </p>
                  <small>
                    {KINDS[row.kind] ?? row.kind}
                    {row.kind === "contact" && row.accountEmail && ` · account ${row.accountEmail}`}
                  </small>
                  {row.gameId && (
                    <small data-testid="admin-feedback-run">
                      Run {row.gameId}
                      {row.sessionId && ` · Session ${row.ordinal ?? "?"} ${row.sessionId}`}
                    </small>
                  )}
                  <p className="feedback-message">{row.message}</p>
                </div>
                <div className="inbox-side">
                  <small>{when(row.createdAt)}</small>
                  <a
                    className="thread-link"
                    href={`/admin/feedback/${row.id}`}
                    data-testid="admin-feedback-open"
                  >
                    Open thread
                  </a>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="card">No messages {page > 1 ? "on this page." : "yet."}</p>
      )}
      {(page > 1 || more) && (
        <nav className="pager" aria-label="Inbox pages">
          {page > 1 && <a href={pageHref(page - 1)}>Previous page</a>}
          <span>Page {page}</span>
          {more && <a href={pageHref(page + 1)}>Next page</a>}
        </nav>
      )}
    </section>
  );
}
