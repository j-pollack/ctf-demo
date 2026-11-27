import { KEYWORDS, REPLIES } from "./agent-script";
import { journey, waitForAttribute } from "./browser";
import { endRun, instruct, memberWithName, startRun, waitFor, waitIdle, waitStatus } from "./run";
import { pool } from "./stack";

const CHAT = REPLIES[KEYWORDS.chat].text;

journey(
  "R11: stopping a held response leaves the run active and resumable",
  async ({ page, expectServerFailure }) => {
    expectServerFailure("inference.failed");
    expectServerFailure("game.response.failed");
    await memberWithName(page, "r11");
    const runId = await startRun(page);
    try {
      const pane = page.getByTestId("session-pane");
      await instruct(pane, `${KEYWORDS.hold} please`);
      await waitFor("the held completion to be reserved", async () => {
        const { rowCount } = await pool().query(
          `SELECT 1 FROM ctf.inference WHERE game_id=$1 AND role='agent' AND settled_at IS NULL`,
          [runId],
        );
        return rowCount === 1;
      });
      await pane.getByTestId("session-stop").click();
      await waitForAttribute(
        pane.getByTestId("transcript-entry").last(),
        "data-state",
        "resumable",
      );
      await waitIdle(pane);
      await waitStatus(page, "active");

      await instruct(pane, `${KEYWORDS.chat} please`);
      await pane.getByTestId("transcript-entry").filter({ hasText: CHAT }).waitFor();
      await waitIdle(pane);
    } finally {
      await endRun(runId);
    }
  },
);
