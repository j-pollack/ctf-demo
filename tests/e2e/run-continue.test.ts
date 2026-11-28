import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import type { Locator } from "playwright";
import { CONTINUE, KEYWORDS } from "./agent-script";
import { TIMEOUT, journey, waitForAttribute } from "./browser";
import {
  endRun,
  instruct,
  memberWithName,
  runStatus,
  startRun,
  waitFor,
  waitForReviews,
  waitIdle,
} from "./run";
import { pool } from "./stack";

const TURNS = 2;
const LIMITS = { response_seconds: "5", auto_continue_turns: String(TURNS) };

// Watches a continued response until its stopped entry shows. The composer is read first, so an
// idle composer seen before the entry is stopped means the page lost track of a running response.
async function busyUntilStopped(composer: Locator, stopped: Locator) {
  for (const deadline = Date.now() + TIMEOUT; Date.now() < deadline; await sleep(50)) {
    const state = await composer.getAttribute("data-state");
    if ((await stopped.count()) && (await stopped.getAttribute("data-state")) === "resumable")
      return;
    assert.equal(state, "busy", "the composer went idle during a continued response");
  }
  throw new Error("the continued response never stopped");
}

journey(
  "R12: a response that reaches its time limit is continued automatically, up to the turn limit",
  async ({ page, expectServerFailure }) => {
    // Each of the three held responses times out and logs this pair.
    for (let response = 0; response <= TURNS; response++) {
      expectServerFailure("inference.failed");
      expectServerFailure("game.response.failed");
    }
    await memberWithName(page, "r12");
    let runId = "";
    try {
      // The page reads the turn limit when it is server-rendered, so store both before /play loads.
      for (const [key, value] of Object.entries(LIMITS))
        await pool().query(
          `INSERT INTO ctf.settings(key,value) VALUES($1,$2)
           ON CONFLICT (key) DO UPDATE SET value=$2`,
          [key, value],
        );
      runId = await startRun(page);
      const pane = page.getByTestId("session-pane");
      const items = pane.getByTestId("transcript-entry");
      const instruction = pane.getByTestId("session-instruction");
      const composer = pane.getByTestId("session-composer");
      await instruct(pane, `${KEYWORDS.hold} please`);

      // Entries in order: the instruction, then each stopped response and each continue.
      await waitForAttribute(items.nth(1), "data-state", "resumable");
      await waitForAttribute(items.nth(2), "data-state", "user");
      await busyUntilStopped(composer, items.nth(3));
      assert.equal(await instruction.inputValue(), "", "a continue was put back in the field");
      await waitForAttribute(items.nth(4), "data-state", "user");
      await busyUntilStopped(composer, items.nth(5));

      // A third continue would be sent in the same render that shows the composer idle, so it
      // would be an entry by the time any later read of the run returns.
      await waitIdle(pane);
      await page.waitForResponse(
        (response) =>
          response.request().method() === "GET" &&
          new URL(response.url()).pathname === `/api/games/${runId}`,
      );
      assert.deepEqual(
        await Promise.all((await items.all()).map((item) => item.getAttribute("data-state"))),
        ["user", "resumable", "user", "resumable", "user", "resumable"],
      );
      assert.equal(await instruction.inputValue(), "");
      assert.equal(await runStatus(runId), "active");
      const { rows } = await pool().query<{ text: string }>(
        `SELECT data->>'text' AS text FROM ctf.events
         WHERE game_id=$1 AND data->>'kind'='user' ORDER BY id`,
        [runId],
      );
      assert.deepEqual(
        rows.map((row) => row.text),
        [`${KEYWORDS.hold} please`, CONTINUE, CONTINUE],
      );
      await waitForReviews(runId);
    } finally {
      await pool().query(`DELETE FROM ctf.settings WHERE key=ANY($1)`, [Object.keys(LIMITS)]);
      // A story that failed mid-response waits for that response to end, so the failures it logs
      // are read here and not by the next story. The story's own error comes first.
      if (runId)
        await waitFor("the last response to end", async () => {
          const { rows } = await pool().query(
            `SELECT 1 FROM ctf.agent_sessions WHERE game_id=$1 AND lease_until>now()`,
            [runId],
          );
          return rows.length === 0;
        }).catch(() => {});
      if (runId) await endRun(runId);
    }
  },
);
