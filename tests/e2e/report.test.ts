import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { journey, signIn, waitForAttribute } from "./browser";
import { endRun, memberWithName, startRun, waitForReviews } from "./run";
import { contactEmail, grantAdmin, mailTo, newEmail, pool, threadIdOf } from "./stack";

journey(
  "R9: a member reports a session of their own run and an admin sees it",
  async ({ page, fresh }) => {
    const email = await memberWithName(page, "e7");
    const runId = await startRun(page);
    try {
      await page.getByTestId("session-add").click();
      await page.getByTestId("session-pane").nth(1).waitFor();
      const { rows: created } = await pool().query(
        `SELECT id FROM ctf.agent_sessions WHERE game_id=$1 AND ordinal=2`,
        [runId],
      );
      const sessionId = created[0].id as string;
      await page.goto(`/runs/${runId}?session=${sessionId}`);
      const report = page.getByTestId("report-open");
      await report.waitFor();
      await report.click();
      await page.getByTestId("report-kind").waitFor();
      const message = `Report from the browser suite ${randomUUID()}`;
      await page.getByTestId("report-kind").selectOption("monitor");
      await page.getByTestId("report-message").fill(message);
      await page.getByTestId("report-submit").click();
      await waitForAttribute(page.getByTestId("report-status"), "data-state", "sent");

      const { rows } = await pool().query(
        `SELECT kind, game_id, session_id FROM ctf.feedback WHERE message=$1`,
        [message],
      );
      assert.deepEqual(rows, [{ kind: "monitor", game_id: runId, session_id: sessionId }]);

      const notification = await mailTo(
        contactEmail,
        `[CTF] Report (monitor) on run ${runId.slice(0, 8)}`,
      );
      assert.equal(notification.replyTo, email);
      await threadIdOf(message);

      const adminPage = await fresh();
      const admin = newEmail("e7-admin");
      await signIn(adminPage, admin, "/account");
      await grantAdmin(admin);
      await adminPage.goto("/admin");
      const row = adminPage.getByTestId("admin-feedback-row").filter({ hasText: message });
      await row.waitFor();
      const ids = (await row.getByTestId("admin-feedback-run").textContent()) ?? "";
      assert.ok(
        ids.includes(runId) && ids.includes(sessionId),
        "the row names the run and session",
      );
      await waitForReviews(runId);
    } finally {
      await endRun(runId);
    }
  },
);
