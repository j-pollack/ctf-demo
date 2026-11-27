import assert from "node:assert/strict";
import { KEYWORDS, REPLIES } from "./agent-script";
import { journey, waitForAttribute } from "./browser";
import { endRun, instruct, memberWithName, startRun, waitIdle } from "./run";
import { pool } from "./stack";

const LIST = REPLIES[KEYWORDS.list].text;
const CHAT = REPLIES[KEYWORDS.chat].text;

journey(
  "R3: a second session shows only its own entries and the add control stops at the limit",
  async ({ page }) => {
    await memberWithName(page, "r3");
    await pool().query(
      `INSERT INTO ctf.settings(key,value) VALUES('sessions_per_run','2') ON CONFLICT (key) DO UPDATE SET value='2'`,
    );
    let runId: string | undefined;
    try {
      runId = await startRun(page);
      const panes = page.getByTestId("session-pane");
      const add = page.getByTestId("session-add");
      await waitForAttribute(add, "data-state", "available");
      await instruct(panes.first(), `${KEYWORDS.list} please`);
      await panes
        .first()
        .getByTestId("transcript-entry")
        .filter({ hasText: LIST })
        .first()
        .waitFor();
      await waitIdle(panes.first());

      await add.click();
      await panes.nth(1).waitFor();
      await instruct(panes.nth(1), `${KEYWORDS.chat} please`);
      await panes.nth(1).getByTestId("transcript-entry").filter({ hasText: CHAT }).waitFor();
      await waitIdle(panes.nth(1));

      assert.equal(await page.getByTestId("session-chip").count(), 2);
      assert.equal(
        await panes.first().getByTestId("transcript-entry").filter({ hasText: CHAT }).count(),
        0,
      );
      assert.equal(
        await panes.nth(1).getByTestId("transcript-entry").filter({ hasText: LIST }).count(),
        0,
      );
      await waitForAttribute(add, "data-state", "unavailable");
      const { rows } = await pool().query(
        `SELECT count(*)::int AS n FROM ctf.agent_sessions WHERE game_id=$1`,
        [runId],
      );
      assert.equal(rows[0].n, 2);
    } finally {
      await pool().query(`DELETE FROM ctf.settings WHERE key='sessions_per_run'`);
      if (runId) await endRun(runId);
    }
  },
);
