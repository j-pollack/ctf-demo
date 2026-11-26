# Feedback mail: notify, reply and show the thread

- Worktree: `/Users/jonathan/Code/ctf/.worktrees/feedback-mail`
- Branch: `feature/feedback-mail`, stacked on `feature/feedback` at `a62ef4e`, the head of pull request 46.
- Do not touch `/Users/jonathan/Code/ctf`, `.worktrees/feedback`, `.worktrees/admin-limits` or `.worktrees/agent-play`.

## Decisions by the owner

- 2026-11-26: Fastmail sends and receives. The site is personal, low traffic and not commercial.
- 2026-11-26: the token is an environment variable named `FASTMAIL_API_TOKEN`. The owner first said `FASTMAIL_TOKEN` and then chose this name.
- 2026-11-26: the address is `contact@ctf.jonathanpollack.net`. Whether it moves to `jonathanpollack.net` is open, so the address is a setting.
- 2026-11-26: the owner questioned keeping the monitor worker on for this. This design does not use the worker.
- 2026-11-26: the owner asked for this work to be committed and opened as a pull request stacked on pull request 46.

## Problem

A contact message or run report is stored and listed on `/admin`. Nobody is told it arrived, an admin cannot answer it from the panel, and a later reply from the sender is not connected to it.

## Scope

1. When a message is stored, send one email into the contact mailbox so the operators see it in Fastmail.
2. An admin page per message that shows the whole conversation and has a reply box.
3. An open or closed status per message, and a state label in the admin list.

## Non-goals

- No poller, no cron and no change to the monitor worker.
- No copy of mail bodies in Postgres. Fastmail holds the conversation, and the panel reads it when an admin opens it.
- No automatic email to the sender. Only an admin's typed reply goes to them.
- The notification goes to the contact mailbox only, not to each admin's own address. A reply sent from a personal account would bypass the thread.
- Mail sent straight to the contact address, without the form, stays in Fastmail and does not appear in the panel.
- A sender who writes a new email instead of replying may not join the thread. Fastmail's own threading decides.
- No attachments and no HTML mail. Quoted text in a sender's reply is shown as it arrives.
- No DNS or Fastmail account setup. Those are the owner's steps and are on the status page.

## Design

Fastmail is the store for mail. The app sends through Fastmail's JMAP API and reads a thread when an admin opens it. Postgres keeps only the link from a feedback row to its Fastmail thread.

### Configuration

- `FASTMAIL_API_TOKEN`: a Fastmail API token with the Email and Email submission scopes.
- `CONTACT_EMAIL`: the address mail is sent from and delivered to.
- Mail is on only when both are set. With either missing, storing a message works as today, nothing is sent, and the thread page shows the stored message with the line "Email is not set up."
- Both go in `.env.example` with a comment. `deploy/operations.md` says to set the token for Production only, so previews send nothing.

### `db/migrations/036-feedback-mail.sql`

Additive and safe to apply twice. Listed in `scripts/setup.ts` after 035 and in the `deploy/operations.md` table.

```sql
ALTER TABLE ctf.feedback ADD COLUMN IF NOT EXISTS mail_thread_id text;
ALTER TABLE ctf.feedback ADD COLUMN IF NOT EXISTS closed_at timestamptz;
```

The notification's Message-ID is not stored. The app sets it to `<feedback-<row id>@<domain of CONTACT_EMAIL>>`, so it can be derived from the row.

### `lib/fastmail.ts`: the JMAP client

Plain `fetch`, no new package. Every request carries `Authorization: Bearer <token>`. Each operation has one deadline, a single `AbortSignal.timeout` shared by every request in it. The caller passes it, and the default is 10 seconds.

- Each operation starts with `GET https://api.fastmail.com/jmap/session` for `apiUrl` and the mail account id. Nothing is cached between operations.
- `sendMail({ to, replyTo, subject, text, messageId, inReplyTo, references })`:
  - A first request reads the mailboxes with roles `drafts` and `sent` and the identity whose email equals `CONTACT_EMAIL`. No such identity is an error.
  - A second request creates the email with `Email/set` in Drafts with `$draft`, then submits it with `EmailSubmission/set` using an explicit `envelope` with `mailFrom` the contact address and exactly one `rcptTo`. `onSuccessUpdateEmail` moves it to Sent and clears `$draft`.
  - `from`, `to` and `replyTo` are passed only as `{ email }` objects. No raw address header is written.
  - `messageId`, when given, is set with `header:Message-ID:asMessageIds`. `inReplyTo` and `references` are set with `header:In-Reply-To:asMessageIds` and `header:References:asMessageIds`.
  - The thread id comes from the `created` entry of `Email/set`. It returns `{ threadId }`.
  - If `Email/set` succeeds and the submission is `notCreated`, the draft is destroyed with `Email/set` before the error is thrown.
  - A recipient or reply-to address is refused before any request unless its local part uses only letters, digits and ``.!#$%&'*+/=?^_`{|}~-``, and its domain only letters, digits, dots and hyphens. That set has no character with a meaning in a mail header.
- `readThreads(threadIds, { bodies })`: one request with `Mailbox/get`, `Thread/get` and `Email/get` by back-reference. Per thread it returns the emails in time order with `messageId`, `from`, `receivedAt`, and whether each is `sent`, which means its `mailboxIds` include the mailbox with role `sent`. Emails with the `$draft` keyword, or in a mailbox with role `drafts`, `junk` or `trash`, are left out. Emails with the same Message-ID are returned once, preferring the copy in Sent. With `bodies` it also fetches the plain text body with `maxBodyValueBytes` 20,000 and reports `truncated`. A message whose only body part is HTML is returned with no text and `htmlOnly` set.
- Any non-200 response, malformed JSON, JMAP method `error`, or `notCreated` entry throws. The log line names the event and the JMAP error type. It never contains the token, an address or a body.

### `lib/feedback-mail.ts`: what the app does with it

- `saveFeedback` in `lib/feedback.ts` returns the new row's id.
- `notifyFeedback(id)`: loads the row and sends one email from `CONTACT_EMAIL` to `CONTACT_EMAIL` with the derived Message-ID. `replyTo` is the sender: the typed email for a contact message, the account email for a report. When that address fails the address rule, the notification is still sent, without a reply-to, and the address is given as a line of text in the body. The subject is `[CTF] Contact from <name>` or `[CTF] Report (<kind>) on run <first 8 of run id>`, with control characters replaced by spaces. The body is the message, and for a report the full run id and session id. It stores `mail_thread_id` on the row. It never throws: a failure is logged and leaves the column null.
- The route starts `notifyFeedback(id)` after the row is saved and hands the promise to `afterResponse` exported from `lib/auth.ts`, so the form answers without waiting for Fastmail.
- `feedbackThread(headers, id)`: admin only. Returns the row and its messages. The first entry is always the stored message from the row. The notification is left out by the start of its Message-ID, `feedback-<row id>@`, so a later change of `CONTACT_EMAIL` does not turn old notifications into replies. Every other email in the Fastmail thread follows in time order with its from address, marked ours when it is `sent`. If mail is not configured, the row has no thread, or the thread cannot be read, it returns the stored message and says which.
- `replyToFeedback(headers, id, text)`: admin only. The text is trimmed, 1 to 5,000 characters, no NUL. The recipient is the row's sender as above. The subject is `Re: ` plus the notification subject.
  - With a thread: `inReplyTo` is the newest message in the thread and `references` is every Message-ID in the thread in order, without repeats. Both are taken from the thread including the notification, so the first reply points at the notification.
  - Without a thread, which covers rows stored before this change and rows whose notification failed: the reply is sent with no threading headers, and the thread id that comes back is stored on the row.
  - When the thread holds no earlier message of ours other than the notification, the stored message is appended to the reply as a quote, each line prefixed with `> `, under the line `You wrote:`.
  - Mail not configured is refused with a `GameError`.
- `setFeedbackClosed(headers, id, closed)`: admin only. Sets or clears `closed_at`.
- `feedbackStates(rows)`: called only from the admin page, after its admin check, with rows from `listFeedback`. It takes no request input and has no check of its own. One `readThreads` call without bodies and with a 3 second deadline, for the listed rows that have a thread. A row is `closed` when `closed_at` is set. Otherwise it is `answered` when the newest email other than the notification is ours, and `waiting` when there is none or the newest is not ours. A row with no thread is `waiting`. If Fastmail cannot be read in time, open rows with a thread get no state and the call does not throw.
- `listFeedback` orders open rows before closed ones, newest first within each, so an open row is not pushed off the list by newer closed ones.
- The admin check is `isAdmin` on the session from `auth.api.getSession({ headers })`, as `lib/game-rules-admin.ts` does it. A non-admin gets the same `GameError` those functions throw.
- A thread id sent to Fastmail always comes from a `ctf.feedback` row. An id from a request is checked as a UUID before any query.

### Admin screens

- `app/admin/feedback/[id]/page.tsx`: an async server page behind the existing admin check, not indexed. A malformed id or an unknown row answers not-found. It renders a presentational `FeedbackThread` component from its own file: kind, sender, time, full run and session ids, state, the conversation as plain text with `white-space: pre-wrap`, each message with its from address and an "ours" or "theirs" mark, "truncated" and "HTML message, open it in Fastmail" notes where they apply, the word "unverified" beside a typed contact email, a reply form with a labelled required textarea and `maxLength`, and a close or reopen button.
- The reply button is a small client component that uses `useFormStatus` and is marked `aria-disabled` while the reply is being sent.
- `app/admin/actions.ts` gains `replyFeedback` and `closeFeedback`. They call the library functions with `await headers()`, keep `redirect` outside `try`, and return to the thread page. A refused or failed reply returns to the page with a fixed error line, the way `/admin?model=refused` does.
- `FeedbackCard` stays a plain component and gains a `states` prop. A small async wrapper in `app/admin/page.tsx`, inside `<Suspense>`, calls `feedbackStates` and renders the card, so the rest of the page renders without waiting for Fastmail. Each row links to its thread page and shows its state when one is known.

### Security

- Replies go only to the address stored on the row or to the member's account email, as one envelope recipient. No request field names a recipient or a thread.
- An email counts as ours only when it is in the Sent mailbox. An inbound email with a forged from address is shown as theirs.
- Mail bodies, names and addresses render as text. Nothing from mail is rendered as HTML, markdown or a link.
- The token can read and send all mail in the Fastmail account it belongs to. The app reads only threads whose ids it stored. The owner has been told and decides whether the contact address gets its own Fastmail user.
- The public form can cause at most one email per stored message, into the operators' own mailbox, and stored messages are already limited.

## Criteria

| ID  | Given, when, then                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M1  | Given mail is configured, when a contact message is stored, then the response is 200 before Fastmail has answered, and afterwards one email has been submitted from the contact address to the contact address with reply-to the sender, the derived Message-ID, the expected subject and body, and the row holds the returned thread id.                                                                                                                                                                                                                                                                          |
| M2  | Given mail is configured, when a run report is stored, then the email's reply-to is the member's account email and its body holds the full run id and session id.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| M3  | Given either variable is missing, when a message is stored, then the response is 200, the row is stored, no request leaves the process, and `mail_thread_id` is null.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| M4  | Given Fastmail answers the session or the API with a non-200, malformed JSON, a method error, `notCreated` on `Email/set`, `notCreated` or a method error on the submission, a missing method response, or nothing within the timeout, when a message is stored, then the response is 200, the row is stored with a null thread, one log line names the failure without the token, an address or the body, and after any failed submission whose draft was created no draft remains. After a timeout the app cannot know what Fastmail did, and any leftover draft is hidden by the draft filter in `readThreads`. |
| M5  | Given a name with a line break or control character, when the notification is built, then the subject has none.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| M6  | Given a row with a thread holding the notification, an admin reply and a sender reply, when an admin opens it, then the data starts with the stored message, leaves out the notification, and lists the two replies in time order with their from addresses, the admin reply marked ours and the sender reply marked theirs.                                                                                                                                                                                                                                                                                       |
| M7  | Given an inbound email in the thread whose from address is the contact address, or copies in Drafts, Junk or Trash, when the thread is read, then the forged email is marked theirs and the other copies are not shown. An email with copies in Sent and in the Inbox appears once, marked ours.                                                                                                                                                                                                                                                                                                                   |
| M8  | Given a row without a thread, mail not configured, or Fastmail failing, when an admin opens it, then the stored message is shown with the matching line and nothing throws.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| M9  | Given an admin and a row with a thread, when they send a reply, then one email goes from the contact address with exactly one envelope recipient and one `to`, the row's sender, with `Re:` subject, `In-Reply-To` the newest message and `References` the whole chain without repeats. The first reply ends with the stored message quoted. A later reply does not.                                                                                                                                                                                                                                               |
| M10 | Given an admin and a row with no thread, when they send a reply, then the email goes out with no threading headers and the row holds the returned thread id.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| M11 | Given an empty, over-long or NUL reply, an unknown or malformed id, mail not configured, or a stored address with a comma, semicolon, angle bracket, quote or space, when a reply is sent, then it is refused and no email is submitted.                                                                                                                                                                                                                                                                                                                                                                           |
| M12 | Given a signed-out caller, a guest or a member who is not an admin, when they call the thread, reply or close function, then it is refused and no request leaves the process.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| M13 | Given rows of each kind, when the list states are computed, then a row with no reply is `waiting`, a row whose newest email is ours is `answered`, a row whose newest email is the sender's is `waiting`, a row with a forged-from newest email is `waiting`, a row with no thread is `waiting`, and a closed row is `closed`. With Fastmail hanging, the call returns within its timeout with no state for open threaded rows.                                                                                                                                                                                    |
| M14 | Closing sets `closed_at` and reopening clears it. Open rows are listed before closed ones.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| M15 | Migration 036 applies twice, and setup and the runbook name it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| M16 | The thread component and the card render mail text, names and addresses as escaped plain text, with a labelled, required, length-limited reply field, the "unverified" mark on a typed address, and the truncated and HTML-only notes.                                                                                                                                                                                                                                                                                                                                                                             |
| M17 | The JMAP client sends the bearer token on every request and throws on each failure listed in M4.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## Checks

| Criteria                                                                | Check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Status                                                                                                                                            |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| M5, the M13 state rule, the M9 quote rule                               | Offline unit tests on the pure parts in `tests/feedback-mail.test.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Passed. `npm run check`, 548 of 548.                                                                                                              |
| M16                                                                     | Offline static renders of `FeedbackThread` and the card in `tests/feedback-thread.test.ts` and `tests/feedback-card.test.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Passed. Same run.                                                                                                                                 |
| M1 to M4, M6 to M15, M17                                                | `tests/integration/feedback-mail.test.ts` on disposable Postgres with real Better Auth, the real route and the real library functions, with Fastmail faked at the `fetch` boundary. M1 holds the fake, asserts the 200 arrives first, then releases it and waits for the stored thread id. Hang cases pass a short timeout.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Passed. 28 of 28 in `tests/integration/feedback-mail-client.test.ts` and `feedback-mail-thread.test.ts`.                                          |
| Real service                                                            | `npm run smoke:fastmail`, run by hand with `--env-file=.env.local` and a real token. Phase `send <outside address>` sends one notification, then one reply to the outside address built the way `replyToFeedback` builds it, with `In-Reply-To` and `References` naming the notification, and prints the thread id. The owner replies to that mail from the outside account. Phase `read <thread id>` exits non-zero unless the notification has an Inbox copy and a Sent copy that both start with the derived Message-ID, the app reply's Sent copy and the outside reply are in the notification's thread, the outside reply is marked theirs, and Drafts holds nothing from the run. The outside address must not be on this Fastmail account, because a reply from inside it also has a copy in Sent. The failure text says so. It never runs in CI. | Passed on 2026-11-26 against the owner's account with an outside address. See "What the real-token check found".                                  |
| Thread page, actions, redirects and the not-found answers, in a browser | On a preview with the real token, before release. Until then the page and action wiring is unproven: `headers()` throws outside a request, so no offline test reaches it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Passed on 2026-11-26 on a local server with the real token. See "What the browser check found". Not run on a deployed preview, where mail is off. |
| All                                                                     | `npm run check`, `npm run test:integration`, `npm run build` with the CI values, both coverage commands                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Passed. Check 548 of 548. Integration 611 of 611 on a clean run. Build exit 0. Coverage commands not run.                                         |

### The fake

One fake in `tests/integration/fastmail-fake.ts`, used by every test that touches Fastmail.

- It checks: the bearer token, the exact `using` list, the order of method calls in each request, that the creation reference used by the submission resolves, that the identity id and mailbox ids are ones it handed out, the envelope, that `from`, `to` and `replyTo` are single `{ email }` objects, that threading headers are arrays of Message-IDs, and that the subject has no control characters.
- It keeps mailboxes, identities, emails and threads in memory and assigns a thread from `In-Reply-To`. A submission addressed to the contact address gets a second copy in the Inbox with the same Message-ID and thread, as a self-sent email does.
- It can be told to fail in each way M4 lists, including a method error on the submission only, and to hold a request until released.
- Every check it fails is recorded, including a check that throws inside `fetch`, and resetting it between cases does not clear the record. Each test fails if any was recorded.
- It has a seed call for an inbound email, with a from address, a mailbox role and an optional `In-Reply-To`.
- Any request it does not expect fails the test.

## Other changes

- `AGENTS.md` and `docs/verification.md` name Fastmail among the external boundaries that may be stubbed.
- `deploy/operations.md` gets the two variables, the Production-only note and the smoke check.

## Steps

0. Read `node_modules/next/dist/docs/01-app/01-getting-started/07-mutating-data.md` and the guides for `after`, `Suspense` streaming and `useFormStatus` before using them.
1. Migration, setup list, runbook row. Verify M15.
2. The fake, then `lib/fastmail.ts`, test first. Verify M17.
3. `notifyFeedback` and the route hook, test first. Verify M1 to M5.
4. Thread reading, reply, close, states and list order, test first. Verify M6 to M14.
5. Thread component, page, actions and the card. Verify M16.
6. Documentation changes and the smoke script.
7. Full gates.

## Review

The independent review found one P1 and four P2 findings, all corrected in one cycle.

- The real-service check could not be completed: it mailed the contact address only, so the owner had nothing to reply to from outside. It now also sends a reply to an outside address.
- A submission that failed with a method error, or with no response, left its draft behind.
- The fake could fail a check without failing the test.
- The notification was matched by a Message-ID that included the domain of `CONTACT_EMAIL`, so moving the address would have broken old threads.
- A form-valid address such as `o'neil@example.com` suppressed the notification.

Smaller points fixed in the same cycle: an email with no Message-ID or sender, the HTML-only rule, storing the thread id when a stored thread has no visible mail, a database error on the thread page shown as not-found, invisible direction characters in the subject, and the test file split.

## Second review pass

The re-review resolved all five earlier findings and raised one new P2, in the fix made after the real-token check. A method error from the implicit `Email/set` that follows a successful submission replaced the submission's result, so `sendMail` reported a delivered email as failed and its cleanup destroyed the Sent copy. The owner approved the fix on 2026-11-26. `invoke` now keeps the first response per call id, and a fake switch returns that error after a successful submission. The new test fails without the fix line. The reviewer confirmed it with no P0 to P2 findings.

Open at P3 from that pass: an implicit update that does not apply leaves a delivered email in Drafts with no log line, and a failed cleanup is silent.

## What the real-token check found

Run on 2026-11-26 against the owner's Fastmail account, to an outside address the owner gave.

- The first two runs of `send` failed with "Fastmail did not submit the email". Fastmail answers a submission that has `onSuccessUpdateEmail` with two responses under one call id: the submission's and an implicit `Email/set`. The client kept the last response per call id and so read the wrong one. Both notifications had been delivered, and the client's cleanup then removed their Sent copies. The fake now returns the implicit response, which turned 17 mail tests red, and the client now takes only the response named after the call. The two stray notifications are in the owner's Inbox.
- The third run of `send` succeeded. An early `read` showed that the notification has an Inbox copy and a Sent copy with the supplied Message-ID, and that the app's reply to the outside address is in the same thread.
- The owner replied from the outside account, and `read` then passed in full. Through `readThreads` the thread shows the notification once marked ours, the app reply marked ours, and the outside reply marked theirs with its text.

## What the browser check found

Run on 2026-11-26 on a local server with a throwaway database and the real token.

- The first notification was refused by Fastmail with `invalidProperties` on `header:Message-ID`. A probe with drafts that were deleted at once showed a length limit: an id of 63 characters is accepted and 65 is refused, which matches a 78-character header line. The id was `feedback-<uuid>@<contact domain>`, 69 characters for the real domain. The earlier real-token check had used a shorter id and so passed. The id is now `fb.<the row id packed to 22 characters>@<contact domain>`, the fake refuses an id over 64 characters, and the smoke script uses an id of real length.
- With that fixed: a contact form submission sent the notification and the row got its thread id. `/admin` showed the row as waiting with a link. The thread page showed the stored message. A reply sent from the page arrived as ours with the quote, and the state became answered. Close and Reopen set and cleared `closed_at`. The thread page signed out, and with a malformed id, answered 404.

## Not verified before the build

- That Fastmail keeps a Message-ID the app supplies.
- That a reply written in a mail client joins the same Fastmail thread as the notification.
- That an email sent from the contact address to itself has a copy in the Inbox.

The smoke check answers all three. If any is false, the thread link changes before release.

## Open questions for the owner

- Whether the contact address stays on `ctf.jonathanpollack.net`, which needs DNS changes, or moves to an address on `jonathanpollack.net`, which Fastmail already serves.
- Whether the contact address gets its own Fastmail user, so the token cannot reach personal mail.
- Whether notifying the contact mailbox only is enough, or other admins should be told some other way.
