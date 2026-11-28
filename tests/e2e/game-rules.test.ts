import assert from "node:assert/strict";
import type { Locator } from "playwright";
import { journey, signIn, waitForAttribute, type Session } from "./browser";
import { grantAdmin, newEmail, pool } from "./stack";

const KEYS = ["monitor_isolation", "bug_fix_required", "jailbreak_catch"];

async function adminPage(session: Session, label: string) {
  const email = newEmail(label);
  await signIn(session.page, email, "/account");
  await grantAdmin(email);
  await session.page.goto("/admin");
  await session.page.getByTestId("page-admin").waitFor();
  return { page: session.page, email };
}

// Presses a rule's switch and waits for the page that comes back to show the new state.
async function flip(rule: Locator, checked: boolean) {
  const toggle = rule.getByTestId("admin-rule-switch");
  await waitForAttribute(toggle, "aria-checked", String(!checked));
  await toggle.click();
  await waitForAttribute(toggle, "aria-checked", String(checked));
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
  const condition = visitor.getByTestId("how-to-win-bug-fix");
  await visitor.goto("/");
  await condition.waitFor();
  const rule = page.getByTestId("admin-rule-row-bug_fix_required");
  try {
    await flip(rule, false);
    const changed = rule.getByTestId("admin-rule-changed");
    await changed.waitFor();
    assert.ok(
      (await changed.textContent())?.includes(email),
      "the changed-by line names the admin",
    );
    assert.deepEqual(await stored("bug_fix_required"), [{ value: "off" }]);

    await visitor.goto("/");
    await visitor.getByTestId("page-home").waitFor();
    assert.equal(await condition.count(), 0);
    await member.goto("/play");
    await member.getByTestId("play-no-run").waitFor();

    await flip(rule, true);
    await visitor.goto("/");
    await condition.waitFor();
  } finally {
    await pool().query(`DELETE FROM ctf.settings WHERE key=ANY($1)`, [KEYS]);
  }
});

journey("A3: an admin turns on the investigator and classifier rules", async (s) => {
  const { page, email } = await adminPage(s, "a3-admin");
  const visitor = await s.fresh();
  const isolation = visitor.getByTestId("rules-isolation");
  const jailbreak = visitor.getByTestId("rules-jailbreak");
  await visitor.goto("/rules");
  await visitor.getByTestId("page-rules").waitFor();
  assert.equal(await isolation.getAttribute("data-state"), "off");
  assert.equal(await jailbreak.getAttribute("data-state"), "off");
  const isolationRule = page.getByTestId("admin-rule-row-monitor_isolation");
  const jailbreakRule = page.getByTestId("admin-rule-row-jailbreak_catch");
  try {
    await flip(isolationRule, true);
    await flip(jailbreakRule, true);
    for (const rule of [isolationRule, jailbreakRule]) {
      const changed = rule.getByTestId("admin-rule-changed");
      await changed.waitFor();
      assert.ok(
        (await changed.textContent())?.includes(email),
        "the changed-by line names the admin",
      );
    }
    assert.deepEqual(await stored("monitor_isolation"), [{ value: "on" }]);
    assert.deepEqual(await stored("jailbreak_catch"), [{ value: "on" }]);

    await visitor.goto("/rules");
    await waitForAttribute(isolation, "data-state", "on");
    await waitForAttribute(jailbreak, "data-state", "on");
  } finally {
    await pool().query(`DELETE FROM ctf.settings WHERE key=ANY($1)`, [KEYS]);
  }
});
