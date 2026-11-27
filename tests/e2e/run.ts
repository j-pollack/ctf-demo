import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import type { Locator, Page } from "playwright";
import { signIn, TIMEOUT, waitForAttribute } from "./browser";
import { baseUrl, newEmail, pool, required } from "./stack";

const cronSecret = required("CRON_SECRET");
const spriteDir = required("E2E_SPRITE_DIR");

// The Sprite directories the faked Sprites service holds.
export const spriteNames = () => readdirSync(spriteDir);

// A signed-in member with a display name, which a run needs. Returns the address.
export async function memberWithName(page: Page, label: string) {
  const email = newEmail(label);
  await signIn(page, email, "/account");
  await pool().query(`UPDATE ctf."user" SET "displayName"=$2 WHERE email=$1`, [
    email,
    email.split("@")[0].replaceAll("-", "_"),
  ]);
  return email;
}

// Starts a run through the setup dialog, opened from /play or, while a run is open, by its New run
// button. Returns the run's id.
export async function startRun(page: Page, from: "play" | "run" = "play") {
  const previous = new URL(page.url()).pathname;
  if (from === "play") await page.goto("/play");
  else await page.getByTestId("run-new").click();
  await page.getByTestId("run-start-confirm").click();
  // A new run's page is another path than the run it replaces.
  await page.waitForURL((url) => url.pathname.startsWith("/runs/") && url.pathname !== previous);
  return new URL(page.url()).pathname.split("/")[2];
}

// Types an instruction into a session's composer and sends it.
export async function instruct(pane: Locator, text: string) {
  await pane.getByTestId("session-instruction").fill(text);
  await pane.getByTestId("session-send").click();
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
    headers: { authorization: `Bearer ${cronSecret}` },
  });
  assert.equal(response.status, 200);
}

export async function runStatus(runId: string) {
  const { rows } = await pool().query(`SELECT status FROM ctf.games WHERE id=$1`, [runId]);
  return rows[0]?.status as string | undefined;
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
