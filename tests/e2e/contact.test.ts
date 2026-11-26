import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { journey, signIn } from "./browser";
import { contactEmail, grantAdmin, mailTo, newEmail, pool, threadIdOf } from "./stack";

journey("E6: a contact message is stored and listed for an admin", async ({ page, fresh }) => {
  const message = `Hello from the browser suite ${randomUUID()}`;
  const sender = newEmail("e6-sender");
  await page.goto("/contact");
  await page.getByLabel("Name").fill("E2E Visitor");
  await page.getByLabel("Email").fill(sender);
  await page.getByLabel("Message").fill(message);
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByText("Thanks. We got your message.").waitFor();

  const { rows } = await pool().query(
    `SELECT kind, name, email FROM ctf.feedback WHERE message=$1`,
    [message],
  );
  assert.deepEqual(rows, [{ kind: "contact", name: "E2E Visitor", email: sender }]);

  const notification = await mailTo(contactEmail, "[CTF] Contact from E2E Visitor");
  assert.equal(notification.replyTo, sender);
  await threadIdOf(message);

  const adminPage = await fresh();
  const admin = newEmail("e6-admin");
  await signIn(adminPage, admin, "/account");
  await grantAdmin(admin);
  await adminPage.goto("/admin");
  await adminPage.getByText(message).waitFor();
});
