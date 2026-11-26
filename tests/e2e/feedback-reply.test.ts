import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { journey, signIn } from "./browser";
import { contactEmail, grantAdmin, mailTo, newEmail, pool, threadIdOf } from "./stack";

const NAME = "Reply Visitor";
const NOTIFICATION = `[CTF] Contact from ${NAME}`;
const REFUSED = "The reply was not sent. Check it and try again.";

const closedAt = async (message: string) =>
  (await pool().query(`SELECT closed_at FROM ctf.feedback WHERE message=$1`, [message])).rows[0]
    .closed_at as Date | null;

journey("A4 to A6: an admin answers a contact message by mail and closes it", async (s) => {
  const { page, fresh } = s;
  const message = `Please reply to me ${randomUUID()}`;
  const visitor = newEmail("a4-visitor");
  await page.goto("/contact");
  await page.getByLabel("Name").fill(NAME);
  await page.getByLabel("Email").fill(visitor);
  await page.getByLabel("Message").fill(message);
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByText("Thanks. We got your message.").waitFor();

  // A4: the notification goes to the contact address, and the visitor's address is the reply-to.
  const notification = await mailTo(contactEmail, NOTIFICATION);
  assert.equal(notification.replyTo, visitor);
  await threadIdOf(message);

  const admin = await fresh();
  const adminEmail = newEmail("a5-admin");
  await signIn(admin, adminEmail, "/account");
  await grantAdmin(adminEmail);
  await admin.goto("/admin");
  const listed = admin.getByRole("listitem").filter({ hasText: message });
  await listed.getByRole("link", { name: "Open thread" }).click();
  await admin.waitForURL(/\/admin\/feedback\/[0-9a-f-]{36}$/);

  // A5: the thread shows the stored message and is waiting for an answer.
  const header = admin.getByRole("heading", { name: "Contact message" }).locator("..");
  const entries = admin.getByRole("listitem");
  await entries.filter({ hasText: message }).waitFor();
  await header.getByText("waiting", { exact: true }).waitFor();
  const reply = `We are looking into it ${randomUUID()}`;
  await admin.getByLabel("Reply").fill(reply);
  await admin.getByRole("button", { name: "Send reply" }).click();

  const answer = entries.filter({ hasText: reply });
  await answer.getByText(contactEmail).waitFor();
  await answer.getByText("ours", { exact: false }).waitFor();
  await header.getByText("answered", { exact: true }).waitFor();
  assert.ok(!admin.url().includes("error=reply"), admin.url());
  assert.equal(await admin.getByText(REFUSED).count(), 0);

  const sent = await mailTo(visitor, `Re: ${NOTIFICATION}`);
  assert.equal(sent.inReplyTo, notification.messageId);
  assert.deepEqual(sent.references, [notification.messageId]);
  await admin.goto("/admin");
  await listed.getByText("answered").waitFor();

  // A6: closing and reopening change the row.
  await listed.getByRole("link", { name: "Open thread" }).click();
  await admin.getByRole("button", { name: "Close" }).click();
  await header.getByText("closed", { exact: true }).waitFor();
  assert.ok(await closedAt(message), "closed_at is set");
  await admin.getByRole("button", { name: "Reopen" }).click();
  await header.getByText("answered", { exact: true }).waitFor();
  assert.equal(await closedAt(message), null);
});
