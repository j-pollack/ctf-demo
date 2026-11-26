import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MODELS } from "../../lib/policy";
import { journey, signIn } from "./browser";
import { grantAdmin, newEmail, pool } from "./stack";

// A finished run with no lease and no spend, owned by one member. The run journeys will replace
// it with a run started through the app.
async function insertRun(email: string) {
  const id = randomUUID();
  const { rows } = await pool().query<{ id: string }>(`SELECT id FROM ctf."user" WHERE email=$1`, [
    email,
  ]);
  await pool().query(
    `INSERT INTO ctf.games(id,owner_id,sprite_name,secret_hash,agent_model,monitor_model,monitor_version,
      status,token_budget,agent_effort,system_prompt,monitor_mode,submission_transport)
     VALUES($1,$2,$3,'hash',$4,'monitor','version','ended',1000,'medium','','async','http')`,
    [id, rows[0].id, `sprite-${id}`, MODELS[0]],
  );
  await pool().query(
    `INSERT INTO ctf.agent_sessions(id,game_id,ordinal,agent_model,agent_effort,system_prompt)
     VALUES($1,$1,1,$2,'medium','')`,
    [id, MODELS[0]],
  );
  return id;
}

journey("E7: a member reports their own run and an admin sees it", async ({ page, fresh }) => {
  const email = newEmail("e7");
  await signIn(page, email, "/account");
  const runId = await insertRun(email);
  await page.goto(`/runs/${runId}`);
  const report = page.getByRole("button", { name: "Report" });
  await report.waitFor();
  await report.click();
  await page.getByRole("heading", { name: "Report a problem" }).waitFor();
  const message = `Report from the browser suite ${randomUUID()}`;
  await page.getByLabel("What went wrong?").selectOption("monitor");
  await page.getByLabel("Message").fill(message);
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByText("Thanks. We got your report.").waitFor();

  const { rows } = await pool().query(
    `SELECT kind, game_id, session_id FROM ctf.feedback WHERE message=$1`,
    [message],
  );
  assert.deepEqual(rows, [{ kind: "monitor", game_id: runId, session_id: runId }]);

  const adminPage = await fresh();
  const admin = newEmail("e7-admin");
  await signIn(adminPage, admin, "/account");
  await grantAdmin(admin);
  await adminPage.goto("/admin");
  await adminPage.getByText(message).waitFor();
  await adminPage.getByText(`Run ${runId} · Session 1 ${runId}`).waitFor();
});
