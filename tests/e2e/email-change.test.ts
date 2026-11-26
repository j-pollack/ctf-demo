import assert from "node:assert/strict";
import { journey, signIn, waitForAttribute } from "./browser";
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

  await page.getByTestId("account-email-input").fill(next);
  await page.getByTestId("account-email-submit").click();
  const sent = page.getByTestId("account-email-status");
  await waitForAttribute(sent, "data-state", "sent");
  const sentText = (await sent.textContent()) ?? "";
  assert.ok(sentText.includes(email) && sentText.includes(next), "the status names both addresses");

  // The first link only confirms: the address stays until the second one is opened.
  await page.goto((await mailTo(email, CONFIRM)).link as string);
  await page.waitForURL((url) => url.pathname === "/account" && url.search === "?email=confirmed");
  await waitForAttribute(page.getByTestId("account-notice"), "data-state", "confirmed");
  assert.deepEqual(await accountOf(email), [before]);
  assert.deepEqual(await accountOf(next), []);

  await page.goto((await mailTo(next, VERIFY)).link as string);
  await page.waitForURL((url) => url.pathname === "/account" && url.search === "?email=changed");
  const changed = page.getByTestId("account-notice");
  await waitForAttribute(changed, "data-state", "changed");
  assert.ok((await changed.textContent())?.includes(next), "the notice names the new address");
  assert.deepEqual(await accountOf(email), []);
  assert.deepEqual(await accountOf(next), [{ ...before, email: next }]);
  const session = await (await page.request.get("/api/auth/get-session")).json();
  assert.equal(session?.user?.email, next);
  assert.equal(session?.user?.id, before.id);
});
