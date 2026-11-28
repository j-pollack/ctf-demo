import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { journey, signIn, waitForAttribute } from "./browser";
import { contactEmail, grantAdmin, mailTo, newEmail, pool, threadIdOf } from "./stack";

journey("E6: a contact message is stored and listed for an admin", async ({ page, fresh }) => {
  const message = `Hello from the browser suite ${randomUUID()}`;
  const sender = newEmail("e6-sender");
  await page.goto("/contact");
  await page.getByTestId("contact-name").fill("E2E Visitor");
  await page.getByTestId("contact-email").fill(sender);
  await page.getByTestId("contact-message").fill(message);
  await page.getByTestId("contact-submit").click();
  await waitForAttribute(page.getByTestId("contact-status"), "data-state", "sent");

  const { rows } = await pool().query(
    `SELECT kind, name, email FROM ctf.feedback WHERE message=$1`,
    [message],
  );
  assert.deepEqual(rows, [{ kind: "contact", name: "E2E Visitor", email: sender }]);

  const notification = await mailTo(contactEmail(), "[CTF] Contact from E2E Visitor");
  assert.equal(notification.replyTo, sender);
  await threadIdOf(message);

  const adminPage = await fresh();
  const admin = newEmail("e6-admin");
  await signIn(adminPage, admin, "/account");
  await grantAdmin(admin);
  await adminPage.goto("/admin");
  await adminPage.getByTestId("admin-feedback-row").filter({ hasText: message }).waitFor();
});
