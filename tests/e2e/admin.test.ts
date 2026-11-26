import assert from "node:assert/strict";
import { MODELS } from "../../lib/policy";
import { journey, signIn, type Session } from "./browser";
import { grantAdmin, newEmail, pool, takeViolations } from "./stack";

const LIMIT = "sessions_per_run";

async function adminPage(session: Session, label: string) {
  const email = newEmail(label);
  await signIn(session.page, email, "/account");
  await grantAdmin(email);
  await session.page.goto("/admin");
  await session.page.getByTestId("page-admin").waitFor();
  return session.page;
}

journey("E8: an admin changes a limit and it survives a reload", async (session) => {
  const page = await adminPage(session, "e8-admin");
  const form = page.getByTestId("admin-limit-row-sessions_per_run");
  const field = form.getByTestId("admin-limit-field");
  const before = await field.inputValue();
  const next = before === "7" ? "8" : "7";
  try {
    await field.fill(next);
    // The action posts to /admin and redirects back to it, so the URL cannot show it finished.
    const saved = page.waitForResponse((r) => r.request().method() === "POST");
    await form.getByTestId("admin-save").click();
    await saved;
    await page.reload();
    assert.equal(await field.inputValue(), next);
    const { rows } = await pool().query(`SELECT value FROM ctf.settings WHERE key=$1`, [LIMIT]);
    assert.deepEqual(rows, [{ value: next }]);
  } finally {
    await pool().query(`DELETE FROM ctf.settings WHERE key=$1`, [LIMIT]);
  }
});

journey("E8: a member who is not an admin gets the not-found page", async (session) => {
  const { page } = session;
  await signIn(page, newEmail("e8-member"), "/account");
  session.expectFailure(404, "/admin");
  const response = await page.goto("/admin");
  assert.equal(response?.status(), 404);
  assert.equal(await page.getByTestId("page-admin").count(), 0);
});

journey("E2: a model change needs the catalogue, which the suite refuses", async (session) => {
  const page = await adminPage(session, "e2-admin");
  session.expectServerFailure("agent_model_change_failed");
  const form = page.getByTestId("admin-model-form");
  const select = form.getByTestId("admin-model-select");
  await select.waitFor();
  const current = await select.inputValue();
  const other = MODELS.find((model) => model !== current);
  assert.ok(other, "the allowlist has a second model");
  await select.selectOption(other);
  await form.getByTestId("admin-save").click();
  await page.getByTestId("admin-model-refused").waitFor();
  const violations = takeViolations();
  assert.equal(violations.length, 1);
  assert.equal(violations[0].url, "https://openrouter.ai/api/v1/models");
  const { rows } = await pool().query(`SELECT 1 FROM ctf.settings WHERE key='agent_model'`);
  assert.equal(rows.length, 0, "the refused model was not stored");
});
