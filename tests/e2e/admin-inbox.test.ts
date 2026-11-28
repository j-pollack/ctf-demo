import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { journey, signIn, waitForAttribute } from "./browser";
import { FEEDBACK_PAGE_SIZE } from "../../lib/feedback";
import { grantAdmin, newEmail, pool } from "./stack";

const SEEDED = FEEDBACK_PAGE_SIZE + 1;

journey("A7: an admin pages through the inbox and comes back from a thread", async ({ page }) => {
  const tag = `inbox paging ${randomUUID()}`;
  const message = (index: number) => `${tag} ${String(index).padStart(2, "0")}`;
  // Dated a year ahead, so these are the newest open rows whatever earlier stories left behind.
  await pool().query(
    `INSERT INTO ctf.feedback(kind,name,email,message,sender,created_at)
     SELECT 'contact','Paging Visitor','paging@example.com',$1||' '||lpad(i::text,2,'0'),'ip:e2e-a7',
       now()+interval '1 year'-make_interval(mins => i)
     FROM generate_series(0,$2-1) i`,
    [tag, SEEDED],
  );
  try {
    const admin = newEmail("a7-admin");
    await signIn(page, admin, "/account");
    await grantAdmin(admin);
    await page.goto("/admin");
    const rows = page.getByTestId("admin-feedback-row");
    const seeded = rows.filter({ hasText: tag });
    await seeded.first().waitFor();
    assert.equal(await seeded.count(), FEEDBACK_PAGE_SIZE);
    assert.match(await rows.first().innerText(), new RegExp(message(0)));
    assert.equal(await page.getByTestId("admin-inbox-previous").count(), 0);

    await page.getByTestId("admin-inbox-next").click();
    await page.waitForURL(/\/admin\?inbox=2#inbox$/);
    const oldest = rows.filter({ hasText: message(SEEDED - 1) });
    await oldest.waitFor();
    assert.match(await rows.first().innerText(), new RegExp(message(SEEDED - 1)));
    await waitForAttribute(oldest, "data-state", "waiting");

    await oldest.getByTestId("admin-feedback-open").click();
    await page.waitForURL(/\/admin\/feedback\/[0-9a-f-]{36}$/);
    await page.getByTestId("feedback-thread-back").click();
    await page.waitForURL(/\/admin#inbox$/);
    await rows.filter({ hasText: message(0) }).waitFor();

    await page.getByTestId("admin-inbox-next").click();
    await page.waitForURL(/\/admin\?inbox=2#inbox$/);
    await page.getByTestId("admin-inbox-previous").click();
    await page.waitForURL(/\/admin\?inbox=1#inbox$/);
    await rows.filter({ hasText: message(0) }).waitFor();
  } finally {
    await pool().query(`DELETE FROM ctf.feedback WHERE sender='ip:e2e-a7'`);
  }
});
