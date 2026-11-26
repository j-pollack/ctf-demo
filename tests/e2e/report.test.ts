import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MODELS } from "../../lib/policy";
import { journey, signIn, waitForAttribute } from "./browser";
import { contactEmail, grantAdmin, mailTo, newEmail, pool, threadIdOf } from "./stack";

// A finished run with no lease and no spend, owned by one member. The run journeys will replace
// it with a run started through the app.
async function insertRun(email: string) {
  const id = randomUUID();
  const sessionId = randomUUID();
  const { rows } = await pool().query<{ id: string }>(`SELECT id FROM ctf."user" WHERE email=$1`, [
    email,
  ]);
  await pool().query(
    `INSERT INTO ctf.games(id,owner_id,sprite_name,secret_hash,agent_model,monitor_model,monitor_version,
      status,token_budget,agent_effort,system_prompt,monitor_mode,submission_transport)
     VALUES($1,$2,$3,'hash',$4,'monitor','version','ended',1000,'medium','','async','http')`,
    [id, rows[0].id, `sprite-${id}`, MODELS[0]],
  );
  // The first session shares the run's id, as in a run the app starts. The report names the second.
  await pool().query(
    `INSERT INTO ctf.agent_sessions(id,game_id,ordinal,agent_model,agent_effort,system_prompt)
     VALUES($1,$1,1,$2,'medium',''),($3,$1,2,$2,'medium','')`,
    [id, MODELS[0], sessionId],
  );
  return { runId: id, sessionId };
}

journey("E7: a member reports their own run and an admin sees it", async ({ page, fresh }) => {
  const email = newEmail("e7");
  await signIn(page, email, "/account");
  const { runId, sessionId } = await insertRun(email);
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
  assert.ok(ids.includes(runId) && ids.includes(sessionId), "the row names the run and session");
});
