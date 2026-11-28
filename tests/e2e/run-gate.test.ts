import assert from "node:assert/strict";
import { smokeHttpUploadCall } from "../../scripts/smoke-contract";
import { GATE_INSTRUCTION } from "./agent-script";
import type { Page } from "playwright";
import { journey } from "./browser";
import {
  assertReviewsHealthy,
  endRun,
  instruct,
  memberWithName,
  replyAfterTurn,
  startRun,
  waitFor,
  waitForReviews,
  runScripted,
} from "./run";
import { pool, realStack } from "./stack";

const LEFT_OPEN = ["creating", "active", "finalizing"];

// One pass of the release gate's journey for a signed-in member, whatever run of theirs is still
// open. It runs on the faked stack on every pull request and on a real staging stack before each
// release, with the same text, and asserts only what a real model's choices cannot change: the run
// ended, the flag arrived, and one final review finished.
async function gate(page: Page) {
  const runId = await startRun(page, "any");
  // Not a secret: the cost and the lease of the run are read by it afterwards.
  console.log(`gate run ${runId}`);
  try {
    const command = smokeHttpUploadCall().arguments.command;
    await instruct(page.getByTestId("session-pane"), `${GATE_INSTRUCTION} ${command}`);
    // Whichever comes first: the flag receipt, or the agent's turn ending without one. A model that
    // refuses leaves the run active, which would otherwise wait out the whole limit.
    await waitFor("a flag receipt or the end of the agent's turn", async () => {
      await assertReviewsHealthy(runId);
      const { rowCount } = await pool().query(
        `SELECT 1 FROM ctf.flag_submissions WHERE game_id=$1`,
        [runId],
      );
      if (rowCount) return true;
      const reply = await replyAfterTurn(runId, GATE_INSTRUCTION);
      if (reply !== undefined)
        assert.fail(`the agent's turn ended without an upload: ${reply.slice(0, 300)}`);
      return false;
    });
    await waitFor("the run to leave active and finalizing", async () => {
      // A review that keeps failing leaves the run finalizing: fail with its error, not a timeout.
      await assertReviewsHealthy(runId);
      const { rows } = await pool().query(`SELECT status FROM ctf.games WHERE id=$1`, [runId]);
      return rows[0] && !LEFT_OPEN.includes(rows[0].status);
    });
    await waitForReviews(runId);

    const { rows: games } = await pool().query(`SELECT status FROM ctf.games WHERE id=$1`, [runId]);
    assert.ok(["caught", "ended", "captured"].includes(games[0].status), games[0].status);
    const { rows: receipts } = await pool().query(
      `SELECT promoted_at FROM ctf.flag_submissions WHERE game_id=$1`,
      [runId],
    );
    assert.equal(receipts.length, 1, "one flag receipt");
    assert.ok(receipts[0].promoted_at, "the receipt is promoted");
    const { rows: reviews } = await pool().query(
      `SELECT verdict, completed_at FROM ctf.monitor_reviews
       WHERE game_id=$1 AND route='final'`,
      [runId],
    );
    assert.equal(reviews.length, 1, "one final review");
    assert.ok(reviews[0].completed_at, "the final review finished");
    assert.ok(["allow", "block"].includes(reviews[0].verdict), `verdict ${reviews[0].verdict}`);
  } finally {
    // The real stack has no cron secret to give the test: the next run's start sweeps the Sprite.
    if (!realStack) await endRun(runId);
  }
}

journey(
  "G1: an upload ends the run with a flag receipt and one finished final review",
  async ({ page }) => {
    await memberWithName(page, "g1");
    await gate(page);
  },
);

// The retry the gate depends on: a failed attempt leaves the member's run open. The faked stack
// can set that up, the real one cannot promise it.
if (!realStack)
  journey(
    "G2: the gate also passes when the member's previous run is still open",
    async ({ page }) => {
      await memberWithName(page, "g2");
      const first = await startRun(page);
      try {
        // The New run button stays disabled until the run has had an instruction.
        await runScripted(page.getByTestId("session-pane"), "list");
        await gate(page);
        const { rows } = await pool().query(`SELECT status FROM ctf.games WHERE id=$1`, [first]);
        assert.equal(rows[0].status, "ended", "the new run replaced the open one");
        await waitForReviews(first);
        // The member's latest run is terminal now: the gate starts from that state too.
        await gate(page);
      } finally {
        await endRun(first);
      }
    },
  );

// A failed attempt can also leave the run open before it had an instruction. Its New run button
// is disabled, so the gate uses that run.
if (!realStack)
  journey(
    "G3: the gate uses the member's open run that has had no instruction",
    async ({ page }) => {
      const email = await memberWithName(page, "g3");
      const first = await startRun(page);
      try {
        await gate(page);
        const { rows } = await pool().query(
          `SELECT g.id, g.status FROM ctf.games g JOIN ctf."user" u ON u.id=g.owner_id WHERE u.email=$1`,
          [email],
        );
        assert.equal(rows.length, 1, "the member has one run");
        assert.equal(rows[0].id, first, "it is the run that was open");
      } finally {
        await endRun(first);
      }
    },
  );
