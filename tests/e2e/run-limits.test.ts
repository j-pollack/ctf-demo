import assert from "node:assert/strict";
import { KEYWORDS, REPLIES } from "./agent-script";
import { journey, waitForAttribute } from "./browser";
import { baseUrl, pool } from "./stack";
import {
  endRun,
  instruct,
  memberWithName,
  runStatus,
  startRun,
  waitForReviews,
  waitIdle,
  waitStatus,
} from "./run";

const CHAT = REPLIES[KEYWORDS.chat].text;
const OVERSPEND = REPLIES[KEYWORDS.overspend].text;
const DAILY_RUNS = 3;

const runCount = async (email: string) =>
  (
    await pool().query(
      `SELECT count(*)::int AS n FROM ctf.games g JOIN ctf."user" u ON u.id=g.owner_id WHERE u.email=$1`,
      [email],
    )
  ).rows[0].n as number;

journey("R5: the fourth run in a day is refused", async ({ page, expectFailure }) => {
  expectFailure(429, "/api/games");
  const email = await memberWithName(page, "r5");
  const panes = page.getByTestId("session-pane");
  const runs: string[] = [];
  try {
    for (let run = 0; run < DAILY_RUNS; run++) {
      runs.push(await startRun(page, run ? "run" : "play"));
      await instruct(panes.first(), `${KEYWORDS.chat} please`);
      await panes.first().getByTestId("transcript-entry").filter({ hasText: CHAT }).waitFor();
      await waitIdle(panes.first());
    }
    assert.equal(await runCount(email), DAILY_RUNS);
    await page.getByTestId("run-new").click();
    await waitForAttribute(page.getByTestId("run-setup-left"), "data-state", "none");
    assert.equal(await page.getByTestId("run-setup-unused").count(), 0);
    assert.equal(await page.getByTestId("run-start-confirm").isDisabled(), true);

    const refused = await page.request.post("/api/games", {
      headers: { Origin: baseUrl },
      data: {},
    });
    assert.equal(refused.status(), 429);
    assert.equal(await runCount(email), DAILY_RUNS);
    // The next story sets the daily cap to zero, which a late review would then meet.
    for (const run of runs) await waitForReviews(run);
  } finally {
    if (runs.length) await endRun(runs[runs.length - 1]);
  }
});

journey("R6: with the daily budget at zero a run is refused", async ({ page, expectFailure }) => {
  expectFailure(429, "/api/games");
  const email = await memberWithName(page, "r6");
  await pool().query(
    `INSERT INTO ctf.settings(key,value) VALUES('daily_cap_microdollars','0')
     ON CONFLICT (key) DO UPDATE SET value='0'`,
  );
  try {
    await page.goto("/play");
    const refused = page.waitForResponse(
      (response) => response.request().method() === "POST" && response.url().endsWith("/api/games"),
    );
    await page.getByTestId("run-start-confirm").click();
    assert.equal((await refused).status(), 429);
    await page.getByTestId("run-dialog-error").waitFor();
    assert.equal(await runCount(email), 0);
  } finally {
    await pool().query(`DELETE FROM ctf.settings WHERE key='daily_cap_microdollars'`);
  }
});

journey(
  "R7: an overspending completion exhausts the run",
  async ({ page, expectServerFailure }) => {
    expectServerFailure("game.response.failed");
    await memberWithName(page, "r7");
    const runId = await startRun(page);
    try {
      const pane = page.getByTestId("session-pane");
      await instruct(pane, `${KEYWORDS.overspend} please`);
      await pane.getByTestId("transcript-entry").filter({ hasText: OVERSPEND }).first().waitFor();
      await waitStatus(page, "exhausted");
      assert.equal(await runStatus(runId), "exhausted");
      assert.equal(await pane.getByTestId("session-composer").count(), 0);
      const refused = await page.request.post(`/api/games/${runId}/prompt`, {
        headers: { Origin: baseUrl },
        data: { prompt: `${KEYWORDS.chat} again` },
      });
      assert.equal(refused.status(), 409);
      await waitForReviews(runId);
    } finally {
      await endRun(runId);
    }
  },
);
