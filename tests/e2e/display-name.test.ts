import assert from "node:assert/strict";
import { journey, signIn, waitForAttribute } from "./browser";
import { newEmail, pool } from "./stack";

journey("E4: a new member chooses a display name that survives a reload", async ({ page }) => {
  const email = newEmail("e4");
  const name = `e4_${email.slice(3, 11)}`;
  await signIn(page, email, "/account");
  await page.getByTestId("account-setup-notice").waitFor();
  await page.getByTestId("account-name-input").fill(name);
  await page.getByTestId("account-name-submit").click();
  const status = page.getByTestId("account-name-status");
  await waitForAttribute(status, "data-state", "saved");
  assert.ok((await status.textContent())?.includes(name), "the status names the saved name");

  await page.reload();
  assert.equal(await page.getByTestId("account-name-input").inputValue(), name);
  assert.equal(await page.getByTestId("account-setup-notice").count(), 0);
  const { rows } = await pool().query(`SELECT "displayName" FROM ctf."user" WHERE email=$1`, [
    email,
  ]);
  assert.deepEqual(rows, [{ displayName: name }]);
});
