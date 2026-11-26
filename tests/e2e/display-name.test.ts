import assert from "node:assert/strict";
import { journey, signIn } from "./browser";
import { newEmail, pool } from "./stack";

journey("E4: a new member chooses a display name that survives a reload", async ({ page }) => {
  const email = newEmail("e4");
  const name = `e4_${email.slice(3, 11)}`;
  await signIn(page, email, "/account");
  await page.getByText("Choose a display name to finish setting up your account.").waitFor();
  await page.getByLabel("Display name").fill(name);
  await page.getByRole("button", { name: "Save name" }).click();
  await page.getByText(`Saved. The leaderboard now shows ${name}.`).waitFor();

  await page.reload();
  assert.equal(await page.getByLabel("Display name").inputValue(), name);
  assert.equal(
    await page.getByText("Choose a display name to finish setting up your account.").count(),
    0,
  );
  const { rows } = await pool().query(`SELECT "displayName" FROM ctf."user" WHERE email=$1`, [
    email,
  ]);
  assert.deepEqual(rows, [{ displayName: name }]);
});
