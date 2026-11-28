import assert from "node:assert/strict";
import { KEYWORDS, REPLIES } from "./agent-script";
import { journey, waitForAttribute } from "./browser";
import {
  endRun,
  instruct,
  memberWithName,
  startRun,
  waitFor,
  waitForReviews,
  waitIdle,
  waitStatus,
} from "./run";
import { pool } from "./stack";

const CHAT = REPLIES[KEYWORDS.chat].text;
const commandStatuses = async (runId: string) =>
  (
    await pool().query<{ status: string }>(
      `SELECT status FROM ctf.sprite_operations WHERE game_id=$1 AND kind='command'`,
      [runId],
    )
  ).rows.map((row) => row.status);

journey(
  "W6: stopping a running command settles it as interrupted and the run goes on",
  async ({ page, expectServerFailure }) => {
    expectServerFailure("game.response.failed");
    await memberWithName(page, "w6");
    const runId = await startRun(page);
    try {
      const pane = page.getByTestId("session-pane");
      await instruct(pane, `${KEYWORDS.long} please`);
      await waitFor("the command to run", async () =>
        (await commandStatuses(runId)).includes("running"),
      );
      await pane.getByTestId("session-stop").click();
      await waitForAttribute(
        pane.getByTestId("transcript-entry").last(),
        "data-state",
        "resumable",
      );
      await pane
        .getByTestId("entry-command")
        .filter({ hasText: REPLIES[KEYWORDS.long].command })
        .waitFor();
      await waitIdle(pane);
      await waitFor("the worker to settle the command", async () => {
        const statuses = await commandStatuses(runId);
        assert.ok(!statuses.includes("completed"), "the stopped command did not complete");
        return statuses.length === 1 && statuses[0] === "interrupted";
      });
      await waitStatus(page, "active");

      await instruct(pane, `${KEYWORDS.chat} please`);
      await pane.getByTestId("transcript-entry").filter({ hasText: CHAT }).waitFor();
      await waitIdle(pane);
      await waitForReviews(runId);
    } finally {
      await endRun(runId);
    }
  },
);
