# Contact page, in-game reports and site footer

- Worktree: `/Users/jonathan/Code/ctf/.worktrees/feedback`
- Branch: `feature/feedback`
- Baseline: `2ded8d2` on `main`, clean tree.
- Concurrent work: `/Users/jonathan/Code/ctf/.worktrees/admin-limits` holds uncommitted changes to `app/game-ui.tsx`, `app/globals.css`, `app/landing-content.tsx`, `app/admin/page.tsx`, `app/run-dialog.tsx`, `tests/landing.test.ts` and `deploy/operations.md`. Do not touch that checkout. Keep edits to those shared files small so the later merge is easy.

## Scope

1. A public `/contact` page with a form for name, email and message.
2. A "Report" control inside a run that sends a category and a message with the run id and the focused session id attached.
3. A site footer linking to `https://jonathanpollack.net`, `https://github.com/j-pollack/ctf-demo` and `/contact`.
4. An admin card that lists what was received, so messages can be read without SQL.

## Non-goals

- No email notification. Contact messages share the Resend account with sign-in links, so a burst of form spam could exhaust the quota and stop sign-in. Decide separately.
- No reply, status or resolve workflow for messages.
- No change to rules copy and no "an unfair catch counts as a win" policy.
- No honeypot or captcha. The rate limits below bound the damage. Add one if spam appears.
- No footer on `/play`, `/runs/[id]`, `/signin`, `/account` or `/admin`.
- Agent play is a separate design discussion.

## Design

One table, one route, one library module.

**`db/migrations/035-feedback.sql`**, additive and safe to apply twice, listed in `scripts/setup.ts` with the game migrations and in the `deploy/operations.md` migration table:

```sql
CREATE TABLE IF NOT EXISTS ctf.feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('contact','bug','monitor','other')),
  name text,
  email text,
  message text NOT NULL,
  user_id text,
  game_id uuid,
  session_id uuid,
  sender text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'contact') = (game_id IS NULL)),
  CHECK (kind <> 'contact' OR (name IS NOT NULL AND email IS NOT NULL)),
  CHECK (kind = 'contact' OR user_id IS NOT NULL),
  CHECK (session_id IS NULL OR game_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS feedback_sender ON ctf.feedback(sender, created_at);
CREATE INDEX IF NOT EXISTS feedback_created ON ctf.feedback(created_at DESC);
```

`user_id` and `game_id` have no foreign keys, like `ctf.inference.user_id`. A message outlives its account and its run, and the scripts that delete test runs are not blocked. Ownership is checked when the row is written. The migration belongs in the game list in `scripts/setup.ts`, because it does not touch `ctf."user"`.

**`lib/feedback.ts`**

- `parseFeedback(data)`: a pure function that turns the request body into a contact message or a run report, or throws `GameError` 400. `kind` is required. `contact` requires `name` and `email` and must not carry `gameId` or `sessionId`. `bug`, `monitor` and `other` require `gameId` in UUID form and accept an optional `sessionId` in UUID form. A string containing a NUL character is refused with 400, because Postgres cannot store it. It trims strings and measures the trimmed JavaScript `.length`, so the limits match the inputs' `maxLength`. Limits are named constants: name 1 to 100 characters, email up to 254 characters matching `local@domain.tld` with no spaces, message 1 to 5,000 characters.
- `saveFeedback(...)`: one `INSERT ... SELECT ... WHERE` statement that inserts only while the sender is under its hourly limit and the table is under the daily limit. No row inserted means `GameError("Too many messages. Try again later.", 429)`. The statement runs inside the existing `transaction()` helper after one `pg_advisory_xact_lock`, the pattern `startGame` uses, so requests sent at once are counted one after another and the limits are exact. One global lock is enough for a table with this little traffic.
- `listFeedback()`: the 50 newest rows, left-joined to `ctf."user"` for the account email and to `ctf.agent_sessions` for the session's ordinal. The first session's id equals the run id, so the card needs the ordinal to be readable.
- Limits: 5 contact messages per sender per hour and 200 contact messages per day in total. 10 reports per account per hour. The daily limit counts contact rows only, so form spam cannot stop members' reports.
- Sender key: `user:<id>` for a report. For a contact message, `ip:` plus an HMAC-SHA256 keyed with `BETTER_AUTH_SECRET` over `"feedback-ip:"` and the client address, so no raw address is stored. The client address is the first `x-forwarded-for` entry, which Vercel sets itself. An IPv6 address is cut to its first four groups, because a client can change the rest freely. The cut is a plain split on `:` and is wrong for an address that compresses zeros inside the first four groups. Mark that with a `ponytail:` comment. A request without the header uses `ip:unknown`.

**`app/api/feedback/route.ts`**, `POST` only, using `checkOrigin`, `body` and `errorResponse` from `lib/http.ts`:

- Order: `checkOrigin`, `body`, `parseFeedback`, then for a report `player` and the ownership check, then `saveFeedback`. A signed-out report with an invalid body therefore gets 400.
- Contact: no sign-in needed. It calls `auth.api.getSession` directly, because `player()` throws for a signed-out caller, and stores `user_id` only for a non-anonymous user.
- Report: `player(request)`, then `getSession(gameId, sessionId, user.id)` when a session id is sent, or `getPublicGameRow(gameId, user.id)` when none is. Both are existing ownership checks. `getGame` is not used because it loads a whole transcript.
- Success is `200 {"ok":true}`. An oversized body keeps the existing 413 from `body()`.

**UI**

- `app/site-footer.tsx`: a `<footer>` with the three links. Rendered at the end of the landing page, the contact page and the Rules, Rank and My Runs panels, inside the scrolling element.
- `app/contact/page.tsx` and `app/contact/contact-form.tsx`: `SiteHeader`, a heading, labelled required inputs with `maxLength`, `type="email"` and `autocomplete`, a send button, a `role="status"` region that is always rendered and empty until a message is sent, a `role="alert"` error, and the line "We keep your name, email and message so we can reply." After success the form is cleared and stays, the status region says the message arrived, and focus stays on the send button. While a send is in flight the button is marked `aria-disabled` and a second submit is ignored. It is not given the `disabled` attribute, because a disabled button drops keyboard focus. The page scrolls like the landing page. It does not use the `.app` wrapper, which is fixed to the screen height.
- `app/report-problem.tsx`: a "Report" button in the run bar actions, before "Details", that opens a dialog built on the existing `@ui-sdk/react/dialog`. The dialog has a native `<select>` labelled "What went wrong?" with "Something is broken" (`bug`), "The monitor got it wrong" (`monitor`) and "Something else" (`other`), a required message textarea, the line "Your run and session IDs are sent with the report.", a send button, and the same status and alert regions with the same behavior after success. The component owns its state and its request. The dialog's contents are a separately exported `ReportForm`, so an offline test can render the fields without opening the dialog. It exports a pure `reportBody(gameId, focusedId, kind, message)` that builds the request body and leaves `sessionId` out when `focusedId` is null or the `PENDING_SESSION` placeholder. `RunBar` receives the focused session id from `RunConsole` as a new optional prop. If the run bar overflows at 390 px, the button moves into the Details inspector instead.
- `app/admin/page.tsx`: a "Feedback" card listing `listFeedback()` rows: UTC time, kind, sender name and email or account email, full run id, session ordinal with the full session id, and the message. Messages render as plain text with `white-space: pre-wrap`. They never go through the markdown renderer, are never auto-linked, and the stored email is never put in an `href`. `listFeedback` is called only after `requireAdmin`.

## Criteria

| ID  | Given, when, then                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Given a valid contact body from an allowed origin, when it is posted signed out, then the response is 200 and one `contact` row holds the trimmed name, email and message with null `user_id` and `game_id`.                                                                                                                                                                                                      |
| F2  | Given a member session, when the same body is posted, then the row holds that member's `user_id`.                                                                                                                                                                                                                                                                                                                 |
| F3  | Given a missing or unknown kind, a missing or over-long name, a malformed email, an empty or over-long message, a malformed id, a contact body with a run or session id, or a report body with no run id, when posted, then the response is 400 and no row is written.                                                                                                                                            |
| F4  | Given a missing or foreign `Origin`, when posted, then the response is 403 and no row is written.                                                                                                                                                                                                                                                                                                                 |
| F5  | Given a report body, when posted signed out, then the response is 401 and no row is written.                                                                                                                                                                                                                                                                                                                      |
| F6  | Given a member who owns a run, when they post a report with that run and one of its sessions, then one row holds the kind, message, `user_id`, `game_id` and `session_id`. A report with the run and no session id is stored with a null `session_id`.                                                                                                                                                            |
| F7  | Given a run owned by another member, or a session id that is not in the run, when a report is posted, then the response is 404 and no row is written.                                                                                                                                                                                                                                                             |
| F8  | Given five accepted contact messages from one address in the hour, when a sixth is posted from that address, then it gets 429 and the table still holds five. A message from another address is still accepted. Two IPv6 addresses that share their first four groups count as one sender. Given eight messages sent at once from one address, exactly five are accepted, three get 429 and five rows are stored. |
| F9  | Given ten accepted reports from one member in the hour, when an eleventh is posted, then it gets 429.                                                                                                                                                                                                                                                                                                             |
| F10 | Given 200 contact rows in the last day, when a contact message is posted, then it gets 429. A member's report is still accepted.                                                                                                                                                                                                                                                                                  |
| F11 | Stored `sender` values never contain the raw client address.                                                                                                                                                                                                                                                                                                                                                      |
| F12 | Migration 035 applies twice without error, and setup and the runbook name it.                                                                                                                                                                                                                                                                                                                                     |
| F13 | The footer renders the three links on `/`, `/contact`, `/rules`, `/rank` and `/runs`, and not in the run console.                                                                                                                                                                                                                                                                                                 |
| F14 | The contact form and the report dialog render labelled, required, length-limited fields and empty live regions before anything is announced.                                                                                                                                                                                                                                                                      |
| F15 | An admin sees the newest messages on `/admin` with run and session ids. A non-admin still gets the existing not-found response.                                                                                                                                                                                                                                                                                   |
| F16 | At 390 px and at 1280 px the run bar with the new button does not overflow, and the dialog can be completed with the keyboard.                                                                                                                                                                                                                                                                                    |
| F17 | The report request carries the run id and the focused session id, and no session id while the placeholder session is focused or no session is focused.                                                                                                                                                                                                                                                            |

## Checks

| Criteria                                                                            | Check                                                                                                                                                                                                                                                                                                                                                                  | Status                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F3 parsing                                                                          | `tests/feedback.test.ts`, offline, on `parseFeedback`                                                                                                                                                                                                                                                                                                                  | Passed. `npm run check`, 537 of 537.                                                                                                                                                                                                                                                                                                                                                                                         |
| F13 on the landing page, Rules, Rank and Contact. F14. F17.                         | Offline static renders of `LandingContent`, `RulesPanel`, `LeaderboardPanel`, the contact form and the report dialog, and a unit test of `reportBody` with a real id, `PENDING_SESSION` and `null`. Files: `tests/site-footer.test.ts`, `tests/contact-form.test.ts`, `tests/report-problem.test.ts`.                                                                  | Passed. Same run.                                                                                                                                                                                                                                                                                                                                                                                                            |
| F1 to F12, F15 query                                                                | `tests/integration/feedback.test.ts` against disposable Postgres through the real route, Better Auth and ownership code. Runs and sessions are inserted with SQL, as `tests/integration/flag-submission-route.test.ts` does, so no Sprite is called. Run with `npm run test:integration -- tests/integration/feedback.test.ts`. Needs Docker and `postgres:18-alpine`. | Passed. 16 of 16 in `tests/integration/feedback.test.ts`. Route and library at 100% line coverage in the integration report.                                                                                                                                                                                                                                                                                                 |
| F13 on `/runs` and its absence from the run console. F15 page. F16. F17 end to end. | Browser check against a disposable local database, not the shared development branch. Send the contact form and see the confirmation and the row on `/admin`. Focus session 2, send a report, and see that session on `/admin`. `GameUI` is not rendered offline, so these have no offline check.                                                                      | Passed on 2026-11-25 with agent-browser against a throwaway Postgres container and synthetic credentials. Contact message stored and shown on `/admin`. Report from session 2 stored with that session's id. Report completed with real key events only. Run bar 390 of 390 px and 1280 of 1280 px wide, no overflow. Footer present on `/runs`, `/rules`, `/rank`, absent from the run console. Signed-out `/admin` is 404. |
| All                                                                                 | `npm run check`, `npm run test:integration`, `npm run build` with the CI environment values, `npm run test:coverage` and `npm run test:integration:coverage`                                                                                                                                                                                                           | Passed. Check 537 of 537. Integration 583 of 583. Build exit 0 with `/contact` and `/api/feedback` in the route list. Both coverage commands ran.                                                                                                                                                                                                                                                                            |

## Steps

0. Read `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md` and any other guide for an API this work uses.
1. Migration, setup list and runbook row. Verify with F12.
2. `lib/feedback.ts` test first, then implementation. Verify with `tests/feedback.test.ts`.
3. Route and integration test, test first. Verify F1 to F11.
4. Footer and its placements. Verify F13.
5. Contact page and form. Verify F14.
6. Report button and dialog. Verify F14.
7. Admin card. Verify F15.
8. Full gates.

## Review

The independent review found no P0 or P1 and two P2 findings. Requests sent at once could pass the limits, and the confirmation replaced the form, which loses keyboard focus and is announced unreliably. Both were corrected in one cycle: the advisory lock and the always-present status region described above. The lead's browser recheck then showed focus still dropping to the page body, because the send button was disabled while busy. The button now uses `aria-disabled`. After that change a keyboard-only send left focus on the send button in both forms, with the status text present and the fields cleared. The re-review asked whether the parallel test proves the lock. With the lock line removed the test failed three runs of three with all eight messages admitted, and with it restored it passed three of three. Before the correction this contract's design text and F14 disagreed about the status region.

## Changes after the owner's review

The owner asked for three changes on 2026-11-26. They are in the second commit.

| ID  | Given, when, then                                                                                                                                      | Check                                                                                                                                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F18 | Given a page shorter than the screen, when it renders, then the footer sits at the bottom edge of the screen. On a longer page it follows the content. | Browser, at 1280 by 900 and 390 by 844: the footer's bottom edge equals the screen's bottom edge on Rank and My Runs, and on Contact at 1280 by 1100. On Rules and the landing page it is reached at the end of the scroll. Passed. |
| F19 | The Rules page says how to report a wrong catch and asks for feedback with a link to Contact.                                                          | `tests/site-footer.test.ts`. Passed.                                                                                                                                                                                                |
| F20 | A caught run's outcome strip ends with one line pointing at Report. A won run has no such line.                                                        | `tests/run-console.test.ts` and `tests/transcript.test.ts`. Passed.                                                                                                                                                                 |

The Rules copy promises that every report is read. It does not say that a wrong catch counts as a win. These three changes were made by the lead and were not sent back to the independent reviewer.

## Deviations and limits

- The length limits live in `lib/feedback-limits.ts`, so the client forms can import them without pulling `pg` into the browser bundle.
- One assertion in `tests/landing.test.ts` now ignores the footer when it checks that the landing page shows no made-up URL.
- The confirmation after a contact message says only that it arrived. It does not promise a reply.
- The browser check used a local database. Nothing was run against the development or production database, and no deployed check has been done.
- The pre-existing 413 text for an oversized body still says "Instruction is too long."

## Open questions for the owner

- Whether to also email each message to the operators, and how to cap it.
- Whether the rules should say that an unfair catch can be reported and may count as a win.
- How long to keep names, emails and messages.
