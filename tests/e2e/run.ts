import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import type { Locator, Page } from "playwright";
import { AFTER_TOOL_TEXT, KEYWORDS, REPLIES } from "./agent-script";
import { signIn, TIMEOUT, waitForAttribute } from "./browser";
import { turnEnd, type StoredEvent } from "./turn-end";
import { baseUrl, grantAdmin, newEmail, pool, required } from "./stack";

// The Sprite directories the faked Sprites service holds.
export const spriteNames = () => readdirSync(required("E2E_SPRITE_DIR"));

// A signed-in member with a display name, which a run needs. Returns the address.
export async function memberWithName(page: Page, label: string) {
  const email = newEmail(label);
  await signIn(page, email, "/account");
  // Only when the member has none: the real stack's one member keeps the name it has.
  await pool().query(
    `UPDATE ctf."user" SET "displayName"=$2 WHERE email=$1 AND "displayName" IS NULL`,
    [email, email.split("@")[0].replaceAll("-", "_")],
  );
  return email;
}

// What /api/games reports for the member's latest run, read by the page's own fetch so that no
// request log holds the session cookie.
async function latestRun(page: Page) {
  const result = await page.evaluate(() =>
    fetch("/api/games").then(async (response) => ({
      status: response.status,
      ok: response.ok,
      body: response.ok ? await response.json() : null,
    })),
  );
  if (!result.ok) throw new Error(`The lookup of the latest run returned ${result.status}.`);
  return result.body.game as {
    id: string;
    status: string;
    turns: number;
    events: { id: number; kind: string }[];
    sessions: { turns: number; busy: boolean }[];
  } | null;
}

// Starts a run through the setup dialog, opened from /play or, while a run is open, by its New run
// button. From "any", /play is opened first and the member's latest run decides, as the page does
// (app/game-ui.tsx, hasActiveRun and the effect that opens the dialog):
// - no run, or one that is not `active` (ended, captured, caught, finalizing, ...): the page opens
//   the dialog itself, so only the confirm button is used. Looking for the New run button instead
//   would race the dialog's opening.
// - `active` with an instruction sent: the page opens no dialog, so New run is clicked.
// - `active` with no instruction: New run stays disabled, so that run is used as it is.
// - `creating`: the app refuses a start, so this fails instead of waiting on a button.
// Returns the run's id.
export async function startRun(page: Page, from: "play" | "run" | "any" = "play") {
  const previous = new URL(page.url()).pathname;
  const confirm = page.getByTestId("run-start-confirm");
  if (from === "run") await page.getByTestId("run-new").click();
  else await page.goto("/play");
  if (from === "any") {
    const game = await latestRun(page);
    if (game?.status === "creating")
      throw new Error(`Run ${game.id} is still creating: the gate cannot start from it.`);
    if (game?.status === "active") {
      const started =
        game.turns > 0 ||
        game.events.some((event) => event.id > 0 && event.kind === "user") ||
        game.sessions.some((session) => session.turns > 0 || session.busy);
      if (!started) return game.id;
      await page.getByTestId("run-new").click();
    }
  }
  await confirm.click();
  // A new run's page is another path than the run it replaces.
  await page.waitForURL((url) => url.pathname.startsWith("/runs/") && url.pathname !== previous);
  return new URL(page.url()).pathname.split("/")[2];
}

// Types an instruction into a session's composer and sends it.
export async function instruct(pane: Locator, text: string) {
  await pane.getByTestId("session-instruction").fill(text);
  await pane.getByTestId("session-send").click();
}

// Sends a keyword instruction and waits until the agent's command has run and the session is idle.
// The run must still be able to respond: not an upload, which ends it.
export async function runScripted(pane: Locator, keyword: keyof typeof KEYWORDS) {
  const finished = pane.getByTestId("transcript-entry").filter({ hasText: AFTER_TOOL_TEXT });
  const before = await finished.count();
  await instruct(pane, `${KEYWORDS[keyword]} please`);
  await pane
    .getByTestId("entry-command")
    .filter({ hasText: REPLIES[KEYWORDS[keyword]].command })
    .waitFor();
  await waitFor("the command's reply", async () => (await finished.count()) > before);
  await waitIdle(pane);
}

// Signs the page in as an admin and opens the admin page.
export async function openAdmin(page: Page, label: string) {
  const email = newEmail(label);
  await signIn(page, email, "/account");
  await grantAdmin(email);
  await page.goto("/admin");
  await page.getByTestId("page-admin").waitFor();
}

// Flips a game rule's switch on the admin page and waits for it to show the new setting.
export async function setRule(toggle: Locator, on: boolean) {
  if ((await toggle.getAttribute("aria-checked")) === String(on)) return;
  await toggle.click();
  await waitForAttribute(toggle, "aria-checked", String(on));
}

// The display name of the member who owns a run, which the leaderboard lists.
export async function ownerName(runId: string) {
  const { rows } = await pool().query(
    `SELECT u."displayName" AS name FROM ctf.games g JOIN ctf."user" u ON u.id=g.owner_id WHERE g.id=$1`,
    [runId],
  );
  return rows[0].name as string;
}

// Whether the leaderboard lists a player, read from the endpoint the page reads.
export async function onLeaderboard(name: string) {
  const { entries } = await (await fetch(`${baseUrl}/api/leaderboard`)).json();
  return (entries as { name: string }[]).some((entry) => entry.name === name);
}

// Waits for a session to finish responding.
export const waitIdle = (pane: Locator) =>
  waitForAttribute(pane.getByTestId("session-composer"), "data-state", "idle");

export const waitStatus = (page: Page, status: string) =>
  waitForAttribute(page.getByTestId("run-status"), "data-state", status);

// The test's own teardown, not behaviour under test: no route lets a member end an active run. It
// ends the one run in SQL, then the cleanup route makes the app delete its Sprite.
export async function endRun(runId: string) {
  await pool().query(
    `UPDATE ctf.games SET status='ended' WHERE id=$1 AND status IN ('creating','active')`,
    [runId],
  );
  await cleanup();
}

export async function cleanup() {
  const response = await fetch(`${baseUrl}/api/cleanup`, {
    headers: { authorization: `Bearer ${required("CRON_SECRET")}` },
  });
  assert.equal(response.status, 200);
}

export async function runStatus(runId: string) {
  const { rows } = await pool().query(`SELECT status FROM ctf.games WHERE id=$1`, [runId]);
  return rows[0]?.status as string | undefined;
}

// Fails at once, naming the error, on a review of the run with an operational error or a monitor
// job that is unresolved. Returns the run's monitor jobs.
export async function assertReviewsHealthy(runId: string) {
  const { rows: errors } = await pool().query<{ operational_error: string }>(
    `SELECT operational_error FROM ctf.monitor_reviews
     WHERE game_id=$1 AND operational_error IS NOT NULL`,
    [runId],
  );
  assert.deepEqual(
    errors.map((row) => row.operational_error),
    [],
    `a review of run ${runId} failed`,
  );
  const { rows: jobs } = await pool().query<{ status: string; reason: string | null }>(
    `SELECT status,reason FROM ctf.monitor_jobs WHERE game_id=$1`,
    [runId],
  );
  const unresolved = jobs.filter((job) => job.status === "unresolved");
  assert.deepEqual(unresolved, [], `a monitor job of run ${runId} is unresolved`);
  return jobs;
}

// What ended the agent's turn on this instruction, read from the database: see turn-end.ts for the
// rule. A turn holds its lease from before the instruction's own event until it ends
// (lib/runner-async.ts), and matching the instruction's text keeps an earlier turn of the run from
// counting.
export async function turnEndedOn(runId: string, instruction: string) {
  const { rows: runs } = await pool().query<{ status: string }>(
    `SELECT status FROM ctf.games WHERE id=$1`,
    [runId],
  );
  const { rowCount: leases } = await pool().query(
    `SELECT 1 FROM ctf.agent_sessions WHERE game_id=$1 AND lease_until>now()`,
    [runId],
  );
  const { rows: events } = await pool().query<{ data: StoredEvent }>(
    `SELECT data FROM ctf.events
     WHERE game_id=$1 AND data->>'kind' IN ('agent','error','user')
       AND id > (SELECT max(id) FROM ctf.events
                 WHERE game_id=$1 AND data->>'kind'='user' AND starts_with(data->>'text',$2))
     ORDER BY id`,
    [runId, instruction],
  );
  return turnEnd({
    status: runs[0].status,
    leased: !!leases,
    events: events.map((row) => row.data),
  });
}

// Waits until the worker has settled every monitor job of the run, so a review's failure lands in
// the story that caused it. A run with no job is settled. An unresolved job or a review with an
// operational error fails at once and names the error.
export async function waitForReviews(runId: string) {
  await waitFor("the run's reviews to settle", async () =>
    (await assertReviewsHealthy(runId)).every(
      (job) => job.status === "caught-up" || job.status === "caught",
    ),
  );
}

// The kinds and texts of a page's transcript entries, in order.
export async function entries(pane: Locator) {
  const items = pane.getByTestId("transcript-entry");
  return Promise.all(
    (await items.all()).map(async (item) => ({
      state: await item.getAttribute("data-state"),
      text: await item.textContent(),
    })),
  );
}

// Polls until the check holds, within the suite's timeout. For a database row or a directory, which
// have no test id to wait on.
export async function waitFor(what: string, check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + TIMEOUT;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${what}.`);
}
