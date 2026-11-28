import assert from "node:assert/strict";
import { flagReadPolicyForRun } from "../../lib/flag-read-policy";
import { KEYWORDS } from "./agent-script";
import { journey, waitForAttribute } from "./browser";
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

const hashesOf = async (runId: string) =>
  (
    await pool().query<{ prompt_hash: string }>(
      `SELECT DISTINCT prompt_hash FROM ctf.monitor_reviews WHERE game_id=$1`,
      [runId],
    )
  ).rows.map((row) => row.prompt_hash);

const policyHash = async (runId: string, isolated: boolean) =>
  flagReadPolicyForRun(
    (await pool().query(`SELECT monitor_version FROM ctf.games WHERE id=$1`, [runId])).rows[0]
      .monitor_version,
    isolated,
  ).promptHash;

const isolated = async (runId: string) =>
  (await pool().query(`SELECT monitor_isolation AS value FROM ctf.games WHERE id=$1`, [runId]))
    .rows[0].value as boolean;

journey(
  "W4: the isolation rule changes the review's prompt, the run's rule and the leaderboard",
  async (session) => {
    const { page } = session;
    await openAdmin(page, "w4-admin");
    const toggle = page
      .getByTestId("admin-rule-row-monitor_isolation")
      .getByTestId("admin-rule-switch");
    const member = await session.fresh();
    await memberWithName(member, "w4");
    const pane = member.getByTestId("session-pane");
    const runs: string[] = [];
    try {
      await setRule(toggle, false);
      runs.push(await startRun(member));
      await runScripted(pane, "fix");
      await instruct(pane, `${KEYWORDS.upload} please`);
      await waitStatus(member, "captured");
      await waitForReviews(runs[0]);
      const name = await ownerName(runs[0]);
      assert.equal(await isolated(runs[0]), false);
      const open = await hashesOf(runs[0]);
      assert.equal(open.length, 1);
      assert.equal(await onLeaderboard(name), true);

      await setRule(toggle, true);
      runs.push(await startRun(member, "run"));
      await runScripted(pane, "list");
      await waitForReviews(runs[1]);
      assert.equal(await isolated(runs[1]), true);
      const shared = await hashesOf(runs[1]);
      assert.equal(shared.length, 1);
      assert.notEqual(shared[0], open[0]);
      assert.equal(shared[0], await policyHash(runs[1], true), "the shared policy's hash");
      assert.equal(open[0], await policyHash(runs[0], false), "the unshared policy's hash");
      assert.equal(
        await onLeaderboard(name),
        false,
        "the capture under the other rule is not ranked",
      );

      await setRule(toggle, false);
      assert.equal(await onLeaderboard(name), true, "the capture is ranked again");
      await member.reload();
      await waitForAttribute(member.getByTestId("rules-isolation"), "data-state", "on");
    } finally {
      await pool().query(`DELETE FROM ctf.settings WHERE key='monitor_isolation'`);
      for (const run of runs) await endRun(run);
    }
  },
);
