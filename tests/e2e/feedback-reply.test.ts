import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { journey, signIn, waitForAttribute } from "./browser";
import { contactEmail, grantAdmin, mailTo, newEmail, pool, threadIdOf } from "./stack";

const NAME = "Reply Visitor";
const NOTIFICATION = `[CTF] Contact from ${NAME}`;

const closedAt = async (message: string) =>
  (await pool().query(`SELECT closed_at FROM ctf.feedback WHERE message=$1`, [message])).rows[0]
    .closed_at as Date | null;

journey("A4 to A6: an admin answers a contact message by mail and closes it", async (s) => {
  const { page, fresh } = s;
  const message = `Please reply to me ${randomUUID()}`;
  const visitor = newEmail("a4-visitor");
  await page.goto("/contact");
  await page.getByTestId("contact-name").fill(NAME);
  await page.getByTestId("contact-email").fill(visitor);
  await page.getByTestId("contact-message").fill(message);
  await page.getByTestId("contact-submit").click();
  await waitForAttribute(page.getByTestId("contact-status"), "data-state", "sent");

  // A4: the notification goes to the contact address, and the visitor's address is the reply-to.
  const notification = await mailTo(contactEmail, NOTIFICATION);
  assert.equal(notification.replyTo, visitor);
  await threadIdOf(message);

  const admin = await fresh();
  const adminEmail = newEmail("a5-admin");
  await signIn(admin, adminEmail, "/account");
  await grantAdmin(adminEmail);
  await admin.goto("/admin");
  const listed = admin.getByTestId("admin-feedback-row").filter({ hasText: message });
  await listed.getByTestId("admin-feedback-open").click();
  await admin.waitForURL(/\/admin\/feedback\/[0-9a-f-]{36}$/);

  // A5: the thread shows the stored message and is waiting for an answer.
  const state = admin.getByTestId("feedback-thread-state");
  const entries = admin.getByTestId("feedback-thread-entry");
  await entries.filter({ hasText: message }).waitFor();
  await waitForAttribute(state, "data-state", "waiting");
  const reply = `We are looking into it ${randomUUID()}`;
  await admin.getByTestId("feedback-thread-reply").fill(reply);
  await admin.getByTestId("feedback-thread-send").click();

  const answer = entries.filter({ hasText: reply });
  await answer.filter({ hasText: contactEmail }).waitFor();
  await waitForAttribute(answer, "data-state", "ours");
  await waitForAttribute(state, "data-state", "answered");
  assert.ok(!admin.url().includes("error=reply"), admin.url());
  assert.equal(await admin.getByTestId("feedback-thread-error").count(), 0);

  const sent = await mailTo(visitor, `Re: ${NOTIFICATION}`);
  assert.equal(sent.inReplyTo, notification.messageId);
  assert.deepEqual(sent.references, [notification.messageId]);
  await admin.goto("/admin");
  await waitForAttribute(listed, "data-state", "answered");

  // A6: closing and reopening change the row.
  await listed.getByTestId("admin-feedback-open").click();
  await admin.getByTestId("feedback-thread-toggle").click();
  await waitForAttribute(state, "data-state", "closed");
  assert.ok(await closedAt(message), "closed_at is set");
  await admin.getByTestId("feedback-thread-toggle").click();
  await waitForAttribute(state, "data-state", "answered");
  assert.equal(await closedAt(message), null);
});
