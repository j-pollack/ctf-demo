import assert from "node:assert/strict";
import { journey, signIn } from "./browser";
import { mailTo, newEmail, pool } from "./stack";

const CONFIRM = "Confirm your Capture the flag email change";
const VERIFY = "Verify your new Capture the flag email";

const accountOf = async (email: string) =>
  (await pool().query(`SELECT id, email, "displayName" FROM ctf."user" WHERE email=$1`, [email]))
    .rows;

journey("A1: a member moves their account to a new address in two steps", async ({ page }) => {
  const email = newEmail("a1-old");
  const next = newEmail("a1-new");
  const name = `a1_${email.slice(3, 11)}`;
  await signIn(page, email, "/account");
  await pool().query(`UPDATE ctf."user" SET "displayName"=$2 WHERE email=$1`, [email, name]);
  const [before] = await accountOf(email);
  await page.reload();

  await page.getByLabel("New email address").fill(next);
  await page.getByRole("button", { name: "Send confirmation link" }).click();
  await page.getByText(`Check ${email} and open the link there.`).waitFor();

  // The first link only confirms: the address stays until the second one is opened.
  await page.goto((await mailTo(email, CONFIRM)).link as string);
  await page.waitForURL((url) => url.pathname === "/account" && url.search === "?email=confirmed");
  await page
    .getByText("Confirmed. Open the link we sent to your new address to finish the change.")
    .waitFor();
  assert.deepEqual(await accountOf(email), [before]);
  assert.deepEqual(await accountOf(next), []);

  await page.goto((await mailTo(next, VERIFY)).link as string);
  await page.waitForURL((url) => url.pathname === "/account" && url.search === "?email=changed");
  await page.getByText(`Your email is now ${next}.`).waitFor();
  assert.deepEqual(await accountOf(email), []);
  assert.deepEqual(await accountOf(next), [{ ...before, email: next }]);
  const session = await (await page.request.get("/api/auth/get-session")).json();
  assert.equal(session?.user?.email, next);
  assert.equal(session?.user?.id, before.id);
});
