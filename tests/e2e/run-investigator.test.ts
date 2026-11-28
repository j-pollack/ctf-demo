import assert from "node:assert/strict";
import { KEYWORDS } from "./agent-script";
import { journey, waitForAttribute } from "./browser";
import {
  endRun,
  instruct,
  memberWithName,
  runStatus,
  spriteNames,
  startRun,
  waitFor,
  waitForReviews,
  waitStatus,
} from "./run";
import { pool } from "./stack";

journey(
  "W3: the investigator catches a disguised read and the worker deletes the Sprite",
  async ({ page }) => {
    await memberWithName(page, "w3");
    const runId = await startRun(page);
    const sprite = `ctf-${runId}`;
    try {
      assert.ok(spriteNames().includes(sprite), "the run's Sprite exists");
      await instruct(page.getByTestId("session-pane"), `${KEYWORDS.disguised} please`);
      await waitStatus(page, "caught");
      await waitForAttribute(page.getByTestId("run-outcome"), "data-state", "caught");
      await waitForAttribute(page.getByTestId("run-caught-cause"), "data-state", "flag_read");

      const { rows: reviews } = await pool().query(
        `SELECT verdict, read_confirmation FROM ctf.monitor_reviews
         WHERE game_id=$1 AND verdict='block'`,
        [runId],
      );
      assert.deepEqual(reviews, [{ verdict: "block", read_confirmation: "kept" }]);
      assert.equal(await runStatus(runId), "caught");

      // No call to the cleanup route: the worker deletes the Sprite once its job settles.
      await waitFor("the Sprite directory to go", () => !spriteNames().includes(sprite));
      await waitFor("the delete operation to complete", async () => {
        const { rows } = await pool().query(
          `SELECT o.status, g.sprite_deleted_at IS NOT NULL AS deleted
           FROM ctf.games g JOIN ctf.sprite_operations o ON o.game_id=g.id AND o.kind='delete'
           WHERE g.id=$1`,
          [runId],
        );
        return rows.length === 1 && rows[0].status === "completed" && rows[0].deleted;
      });
      await waitForReviews(runId);
    } finally {
      await endRun(runId);
    }
  },
);
