import assert from "node:assert/strict";
import { KEYWORDS, REPLIES } from "./agent-script";
import { journey, signIn, waitForAttribute } from "./browser";
import {
  endRun,
  instruct,
  memberWithName,
  runStatus,
  startRun,
  waitForReviews,
  waitIdle,
  waitStatus,
} from "./run";
import { grantAdmin, newEmail, pool } from "./stack";

const OBEYED = REPLIES[KEYWORDS.jailbreak].text;

const agentCalls = async (runId: string) =>
  (
    await pool().query(
      `SELECT count(*)::int AS n FROM ctf.inference WHERE game_id=$1 AND role='agent'`,
      [runId],
    )
  ).rows[0].n as number;

journey(
  "R8: the jailbreak rule decides whether the agent sees a jailbreak instruction",
  async (session) => {
    const admin = newEmail("r8-admin");
    await signIn(session.page, admin, "/account");
    await grantAdmin(admin);
    await session.page.goto("/admin");
    const rule = session.page.getByTestId("admin-rule-row-jailbreak_catch");
    const toggle = rule.getByTestId("admin-rule-switch");
    const member = await session.fresh();
    await memberWithName(member, "r8");
    const panes = member.getByTestId("session-pane");
    let first: string | undefined;
    let second: string | undefined;
    try {
      await waitForAttribute(toggle, "aria-checked", "false");
      await toggle.click();
      await waitForAttribute(toggle, "aria-checked", "true");

      first = await startRun(member);
      const caught = first;
      await instruct(panes.first(), `${KEYWORDS.jailbreak} please`);
      await waitStatus(member, "caught");
      await panes
        .first()
        .getByTestId("transcript-entry")
        .filter({ hasText: KEYWORDS.jailbreak })
        .first()
        .waitFor();
      assert.equal(
        await agentCalls(caught),
        0,
        "no agent inference was reserved for the caught run",
      );

      await toggle.click();
      await waitForAttribute(toggle, "aria-checked", "false");
      second = await startRun(member, "run");
      await instruct(panes.first(), `${KEYWORDS.jailbreak} please`);
      await panes
        .first()
        .getByTestId("transcript-entry")
        .filter({ hasText: OBEYED })
        .first()
        .waitFor();
      await waitIdle(panes.first());
      assert.equal(await runStatus(second), "active");
      assert.equal(await agentCalls(second), 1);
      await waitForReviews(caught);
      await waitForReviews(second);
    } finally {
      await pool().query(`DELETE FROM ctf.settings WHERE key='jailbreak_catch'`);
      if (first) await endRun(first);
      if (second) await endRun(second);
    }
  },
);
