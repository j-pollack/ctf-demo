import assert from "node:assert/strict";
import { KEYWORDS } from "./agent-script";
import { journey } from "./browser";
import {
  endRun,
  instruct,
  memberWithName,
  onLeaderboard,
  openAdmin,
  ownerName,
  runScripted,
  setRule,
  startRun,
  waitForReviews,
  waitStatus,
} from "./run";
import { pool } from "./stack";

const stored = async (runId: string) =>
  (
    await pool().query(
      `SELECT g.status,
         (SELECT e.data->>'bugsPassed' FROM ctf.events e
           WHERE e.game_id=g.id AND e.data->>'kind'='submit') AS "bugsPassed"
       FROM ctf.games g WHERE g.id=$1`,
      [runId],
    )
  ).rows[0];

// What decided a finished run: whether its flag was right, the rule it copied, and its scoring.
const decided = async (runId: string) =>
  (
    await pool().query(
      `SELECT g.submitted_flag_correct AS "flagCorrect", g.bug_fix_required AS "ruleOn",
         coalesce((SELECT array_agg(o.status) FROM ctf.sprite_operations o
           WHERE o.game_id=g.id AND o.kind='score'),'{}') AS "scoring"
       FROM ctf.games g WHERE g.id=$1`,
      [runId],
    )
  ).rows[0];

journey("W1: a fixed bug and an upload capture the run and rank the member", async ({ page }) => {
  await memberWithName(page, "w1");
  const runId = await startRun(page);
  try {
    const pane = page.getByTestId("session-pane");
    await runScripted(pane, "fix");
    await instruct(pane, `${KEYWORDS.upload} please`);
    await waitStatus(page, "finalizing");
    await waitStatus(page, "captured");
    assert.deepEqual(await stored(runId), { status: "captured", bugsPassed: "1" });

    await page.goto("/rank");
    const name = await ownerName(runId);
    await page.getByTestId("rank-row").filter({ hasText: name }).waitFor();
    assert.equal(await page.getByTestId("rank-name").filter({ hasText: name }).count(), 1);
    await waitForReviews(runId);
  } finally {
    await endRun(runId);
  }
});

journey(
  "W2: an upload with no fix ends the run, and with the rule off it captures",
  async (session) => {
    const { page } = session;
    await openAdmin(page, "w2-admin");
    const toggle = page
      .getByTestId("admin-rule-row-bug_fix_required")
      .getByTestId("admin-rule-switch");
    const member = await session.fresh();
    await memberWithName(member, "w2");
    const runs: string[] = [];
    try {
      runs.push(await startRun(member));
      await instruct(member.getByTestId("session-pane"), `${KEYWORDS.upload} please`);
      await waitStatus(member, "ended");
      assert.deepEqual(await stored(runs[0]), { status: "ended", bugsPassed: "0" });
      assert.equal(await onLeaderboard(await ownerName(runs[0])), false);
      assert.deepEqual(await decided(runs[0]), {
        flagCorrect: true,
        ruleOn: true,
        scoring: ["completed"],
      });

      await setRule(toggle, false);
      runs.push(await startRun(member, "run"));
      await instruct(member.getByTestId("session-pane"), `${KEYWORDS.upload} please`);
      await waitStatus(member, "captured");
      assert.equal((await stored(runs[1])).status, "captured");
      assert.deepEqual(await decided(runs[1]), { flagCorrect: true, ruleOn: false, scoring: [] });
      for (const run of runs) await waitForReviews(run);
    } finally {
      await pool().query(`DELETE FROM ctf.settings WHERE key='bug_fix_required'`);
      for (const run of runs) await endRun(run);
    }
  },
);
