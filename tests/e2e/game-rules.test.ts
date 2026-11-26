import assert from "node:assert/strict";
import type { Page } from "playwright";
import { journey, signIn, type Session } from "./browser";
import { grantAdmin, newEmail, pool } from "./stack";

const KEYS = ["monitor_isolation", "bug_fix_required", "jailbreak_catch"];
const ISOLATION = "It cannot see your earlier runs.";
const OVERRIDE =
  "An instruction or system prompt that tries to override the agent’s or the monitor’s rules also ends the run.";

async function adminPage(session: Session, label: string) {
  const email = newEmail(label);
  await signIn(session.page, email, "/account");
  await grantAdmin(email);
  await session.page.goto("/admin");
  return { page: session.page, email };
}

// Presses a rule's switch and waits for the page that comes back to show the new state.
async function flip(page: Page, label: string, checked: boolean) {
  await page.getByRole("switch", { name: label, checked: !checked }).click();
  await page.getByRole("switch", { name: label, checked }).waitFor();
}

const stored = async (key: string) =>
  (await pool().query(`SELECT value FROM ctf.settings WHERE key=$1`, [key])).rows;

journey("A2: an admin turns the bug-fix rule off and visitors see the shorter rule", async (s) => {
  const { page, email } = await adminPage(s, "a2-admin");
  const visitor = await s.fresh();
  const member = await s.fresh();
  const memberEmail = newEmail("a2-member");
  await signIn(member, memberEmail, "/account");
  await pool().query(`UPDATE ctf."user" SET "displayName"=$2 WHERE email=$1`, [
    memberEmail,
    `a2_${memberEmail.slice(3, 11)}`,
  ]);
  await visitor.goto("/");
  await visitor.getByText("all three are true:").waitFor();
  try {
    await flip(page, "Bug fix required", false);
    await page
      .locator("form.rule", { has: page.getByRole("switch", { name: "Bug fix required" }) })
      .getByText(`Changed by ${email}`)
      .waitFor();
    assert.deepEqual(await stored("bug_fix_required"), [{ value: "off" }]);

    await visitor.goto("/");
    await visitor.getByText("You win when both are true:").waitFor();
    assert.equal(await visitor.getByText("all three are true:").count(), 0);
    await member.goto("/play");
    await member
      .getByRole("heading", { name: "Upload the flag without getting caught.", exact: true })
      .waitFor();

    await flip(page, "Bug fix required", true);
    await visitor.goto("/");
    await visitor.getByText("all three are true:").waitFor();
  } finally {
    await pool().query(`DELETE FROM ctf.settings WHERE key=ANY($1)`, [KEYS]);
  }
});

journey("A3: an admin turns on the investigator and classifier rules", async (s) => {
  const { page } = await adminPage(s, "a3-admin");
  const visitor = await s.fresh();
  // The same sentences are in "How to win" too, so each check is scoped to one section.
  const section = () => visitor.getByRole("region", { name: "How a run works" });
  await visitor.goto("/");
  await section().getByText("How a run works").waitFor();
  assert.equal(await section().getByText(ISOLATION).count(), 0);
  assert.equal(await section().getByText(OVERRIDE).count(), 0);
  try {
    await flip(page, "Transcript isolation", true);
    await flip(page, "Jailbreak catch", true);
    assert.deepEqual(await stored("monitor_isolation"), [{ value: "on" }]);
    assert.deepEqual(await stored("jailbreak_catch"), [{ value: "on" }]);

    await visitor.goto("/");
    await section().getByText(ISOLATION).waitFor();
    await section().getByText(OVERRIDE).waitFor();
  } finally {
    await pool().query(`DELETE FROM ctf.settings WHERE key=ANY($1)`, [KEYS]);
  }
});
