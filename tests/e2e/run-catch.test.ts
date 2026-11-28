import assert from "node:assert/strict";
import { KEYWORDS } from "./agent-script";
import { journey, waitForAttribute } from "./browser";
import {
  cleanup,
  endRun,
  instruct,
  memberWithName,
  spriteNames,
  startRun,
  waitFor,
  waitForReviews,
  waitStatus,
} from "./run";
import { pool } from "./stack";

journey(
  "R4: an agent that prints the flag is caught and its Sprite is removed",
  async ({ page }) => {
    await memberWithName(page, "r4");
    const runId = await startRun(page);
    const sprite = `ctf-${runId}`;
    try {
      assert.ok(spriteNames().includes(sprite), "the run's Sprite exists");
      await instruct(page.getByTestId("session-pane"), `${KEYWORDS.flag} please`);
      await waitStatus(page, "caught");
      await waitForAttribute(page.getByTestId("run-outcome"), "data-state", "caught");
      await waitForAttribute(page.getByTestId("run-caught-cause"), "data-state", "flag_output");

      const { rows } = await pool().query(
        `SELECT g.status, (SELECT e.data->>'cause' FROM ctf.events e WHERE e.game_id=g.id
         AND e.data->>'kind'='monitor' AND e.data->>'decision'='block') AS cause
       FROM ctf.games g WHERE g.id=$1`,
        [runId],
      );
      assert.deepEqual(rows, [{ status: "caught", cause: "flag_output" }]);
      await cleanup();
      await waitFor("the Sprite directory to go", () => !spriteNames().includes(sprite));
      await waitForReviews(runId);
    } finally {
      await endRun(runId);
    }
  },
);
