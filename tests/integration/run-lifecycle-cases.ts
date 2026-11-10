import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import type { Pool } from "pg";
async function fixture(pool: Pool) {
  const gameId = randomUUID();
  const sessionId = randomUUID();
  const lease = randomUUID();
  await pool.query(
    `INSERT INTO ctf.games(id,owner_id,sprite_name,secret_hash,agent_model,monitor_model,monitor_version,
      token_budget,status,agent_effort,system_prompt)
     VALUES($1,'lifecycle-fixture',$2,'hash','agent','monitor','v1',10000,'active','medium','')`,
    [gameId, `lifecycle-${gameId}`],
  );
  await pool.query(
    `INSERT INTO ctf.agent_sessions(id,game_id,ordinal,agent_model,agent_effort,system_prompt,lease,lease_until)
     VALUES($1,$2,1,'agent','medium','',$3,now()+interval '5 minutes')`,
    [sessionId, gameId, lease],
  );
  return { gameId, sessionId, lease };
}

async function review(
  register: typeof import("../../lib/run-lifecycle").registerLifecycleReview,
  pool: Pool,
  gameId: string,
  sessionId: string,
  lease: string,
  finalizationToken?: string,
  revision = 0,
  targetKind: "transcript" | "submission" = "transcript",
) {
  const id = randomUUID();
  await register({
    id,
    gameId,
    sessionId,
    sourceLease: lease,
    finalizationToken,
    snapshotRevision: revision,
    targetKind,
    model: "monitor",
    promptVersion: "test-v1",
  });
  return id;
}

export async function runLifecycleCases(t: TestContext, pool: Pool) {
  const {
    assertExecutionPermit,
    assertMonitorAuthorization,
    beginFinalization,
    bindQueuedLifecycleReview,
    catchRun,
    expireFinalizations,
    finalizeRun,
    getDrainReadiness,
    insertLifecycleReview,
    registerLifecycleReview,
    releaseFinalization,
  } = await import("../../lib/run-lifecycle");
  await t.test(
    "finalization admits one submitter and only drains registered monitor work",
    async () => {
      const f = await fixture(pool);
      try {
        const pendingReviewId = await review(
          registerLifecycleReview,
          pool,
          f.gameId,
          f.sessionId,
          f.lease,
        );
        const commandReviewId = randomUUID();
        await pool.query(
          `INSERT INTO ctf.monitor_reviews(id,game_id,session_id,snapshot_revision,target_kind,model,prompt_version,
            verdict,admitted_revision,execution_generation,originating_lease)
           VALUES($1,$2,$3,0,'command','monitor','test-v1','allow',1,0,$4)`,
          [commandReviewId, f.gameId, f.sessionId, f.lease],
        );
        const finalization = await beginFinalization(f.gameId, f.sessionId, f.lease);
        assert.deepEqual(
          new Set(finalization.pendingReviewIds),
          new Set([pendingReviewId, commandReviewId]),
          "the barrier records the complete pre-barrier drain set",
        );
        await assert.rejects(
          beginFinalization(f.gameId, f.sessionId, f.lease),
          /stopped|finalizing/,
        );
        const client = await pool.connect();
        try {
          await assertMonitorAuthorization(client, f.gameId, f.sessionId, f.lease, {
            pendingReviewId,
          });
          await assertMonitorAuthorization(client, f.gameId, f.sessionId, f.lease, {
            finalizationToken: finalization.token,
          });
          await assert.rejects(
            assertMonitorAuthorization(client, f.gameId, f.sessionId, f.lease, {}),
            /not authorized/,
          );
        } finally {
          client.release();
        }
        await pool.query(
          "UPDATE ctf.agent_sessions SET lease_until=now()-interval '1 second' WHERE game_id=$1 AND id=$2",
          [f.gameId, f.sessionId],
        );
        const expiredClient = await pool.connect();
        try {
          await assert.rejects(
            assertMonitorAuthorization(expiredClient, f.gameId, f.sessionId, f.lease, {
              pendingReviewId,
            }),
            /stopped/,
          );
        } finally {
          expiredClient.release();
        }
        assert.equal(
          (await getDrainReadiness(f.gameId, finalization.token, finalization.sessionId)).ready,
          false,
          "expired source lease leaves the pre-barrier review unresolved",
        );
        await pool.query(
          "UPDATE ctf.agent_sessions SET lease_until=now()+interval '5 minutes' WHERE game_id=$1 AND id=$2",
          [f.gameId, f.sessionId],
        );
        assert.equal(
          await finalizeRun(
            f.gameId,
            finalization.token,
            finalization.revision,
            "captured",
            randomUUID(),
            { sessionId: finalization.sessionId, sourceLease: finalization.sourceLease },
          ),
          null,
          "unresolved pre-barrier review prevents capture",
        );
        await pool.query(
          "UPDATE ctf.monitor_reviews SET verdict='unknown',completed_at=now() WHERE id=$1",
          [pendingReviewId],
        );
        await pool.query(
          "UPDATE ctf.monitor_reviews SET verdict='allow',completed_at=now() WHERE id=$1",
          [commandReviewId],
        );
        assert.equal(
          (await getDrainReadiness(f.gameId, finalization.token, finalization.sessionId)).ready,
          false,
          "unknown verdict cannot release the drain",
        );
        await pool.query("UPDATE ctf.monitor_reviews SET verdict='allow' WHERE id=$1", [
          pendingReviewId,
        ]);
        assert.equal(
          await finalizeRun(
            f.gameId,
            finalization.token,
            finalization.revision,
            "captured",
            randomUUID(),
            { sessionId: finalization.sessionId, sourceLease: finalization.sourceLease },
          ),
          null,
          "missing command outcome prevents capture",
        );
        await pool.query(
          "UPDATE ctf.monitor_reviews SET completed_revision=2,outcome='completed' WHERE id=$1",
          [commandReviewId],
        );
        assert.equal(
          (await getDrainReadiness(f.gameId, finalization.token, finalization.sessionId)).ready,
          true,
        );
        const finalReviewId = await review(
          registerLifecycleReview,
          pool,
          f.gameId,
          f.sessionId,
          f.lease,
          finalization.token,
          finalization.revision,
          "submission",
        );
        await pool.query(
          "UPDATE ctf.monitor_reviews SET verdict='allow',completed_at=now() WHERE id=$1",
          [finalReviewId],
        );
        await pool.query(
          "UPDATE ctf.agent_sessions SET lease_until=now()-interval '1 second' WHERE id=$1",
          [f.sessionId],
        );
        assert.equal(
          await finalizeRun(
            f.gameId,
            finalization.token,
            finalization.revision,
            "captured",
            finalReviewId,
            { sessionId: finalization.sessionId, sourceLease: finalization.sourceLease },
          ),
          null,
          "finalizer session lease must remain live at commit",
        );
        await pool.query(
          "UPDATE ctf.agent_sessions SET lease_until=now()+interval '5 minutes' WHERE id=$1",
          [f.sessionId],
        );
        assert.deepEqual(
          await finalizeRun(
            f.gameId,
            finalization.token,
            finalization.revision,
            "captured",
            finalReviewId,
            { sessionId: finalization.sessionId, sourceLease: finalization.sourceLease },
          ),
          {
            token: finalization.token,
            revision: finalization.revision,
            status: "captured",
          },
        );
        assert.equal(
          (await pool.query("SELECT status FROM ctf.games WHERE id=$1", [f.gameId])).rows[0].status,
          "captured",
        );
      } finally {
        await pool.query("DELETE FROM ctf.events WHERE game_id=$1", [f.gameId]);
        await pool.query("DELETE FROM ctf.games WHERE id=$1", [f.gameId]);
      }
    },
  );

  await t.test("a draining block wins atomically over capture and release", async () => {
    const f = await fixture(pool);
    try {
      const reviewId = await review(registerLifecycleReview, pool, f.gameId, f.sessionId, f.lease);
      const finalization = await beginFinalization(f.gameId, f.sessionId, f.lease);
      const caught = await catchRun({
        gameId: f.gameId,
        sessionId: f.sessionId,
        sourceLease: f.lease,
        reviewId,
        decision: {
          verdict: "block",
          reason: "protected file attempt",
          evidence: [{ ref: "m0", excerpt: "read flag" }],
          latencyMs: 12,
          calls: 2,
          retrievalCalls: 1,
          initialEvidenceCount: 3,
          retrievedRefs: ["s1:m2"],
        },
        event: { kind: "caught", reason: "protected file attempt" },
      });
      assert.ok(caught);
      assert.equal(caught.status, "caught");
      assert.equal(
        await catchRun({
          gameId: f.gameId,
          sessionId: f.sessionId,
          sourceLease: f.lease,
          reviewId,
          decision: { verdict: "block", reason: "duplicate" },
          event: { kind: "caught", reason: "duplicate" },
        }),
        false,
        "duplicate catch cannot increment blocks or write a second event",
      );
      assert.equal(
        await finalizeRun(
          f.gameId,
          finalization.token,
          finalization.revision,
          "captured",
          randomUUID(),
          { sessionId: finalization.sessionId, sourceLease: finalization.sourceLease },
        ),
        null,
      );
      assert.equal(await releaseFinalization(f.gameId, finalization.token), null);
      const { rows } = await pool.query(
        `SELECT g.status,g.blocks,r.verdict,r.latency_ms,r.calls,r.retrieval_calls,
          r.initial_evidence_count,r.retrieved_refs,e.review_id,e.id FROM ctf.games g
         JOIN ctf.monitor_reviews r ON r.game_id=g.id JOIN ctf.events e ON e.game_id=g.id WHERE g.id=$1`,
        [f.gameId],
      );
      assert.deepEqual(
        rows.map((row) => [
          row.status,
          row.blocks,
          row.verdict,
          row.latency_ms,
          row.calls,
          row.retrieval_calls,
          row.initial_evidence_count,
          row.retrieved_refs,
          row.review_id,
          Number(row.id),
        ]),
        [["caught", 1, "block", 12, 2, 1, 3, ["s1:m2"], reviewId, caught.event.id]],
      );
    } finally {
      await pool.query("DELETE FROM ctf.events WHERE game_id=$1", [f.gameId]);
      await pool.query("DELETE FROM ctf.games WHERE id=$1", [f.gameId]);
    }
  });

  await t.test(
    "queued pre-barrier and tagged in-flight reviews can bind during drain",
    async () => {
      const f = await fixture(pool);
      try {
        const reviewId = randomUUID();
        const insert = async (id: string, eligibleDrainToken?: string) => {
          const client = await pool.connect();
          try {
            await client.query("BEGIN");
            await insertLifecycleReview(client, {
              id,
              gameId: f.gameId,
              sessionId: f.sessionId,
              sourceLease: f.lease,
              snapshotRevision: 0,
              targetKind: "transcript",
              model: "monitor",
              promptVersion: "test-v1",
              executionGeneration: 0,
              eligibleDrainToken,
            });
            await client.query("COMMIT");
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          } finally {
            client.release();
          }
        };
        await insert(reviewId);
        const finalization = await beginFinalization(f.gameId, f.sessionId, f.lease);
        assert.deepEqual(finalization.pendingReviewIds, [reviewId]);
        await bindQueuedLifecycleReview(
          reviewId,
          f.gameId,
          f.sessionId,
          f.lease,
          finalization.executionGeneration,
          finalization.revision,
        );
        const lateReviewId = randomUUID();
        await insert(lateReviewId, finalization.token);
        await bindQueuedLifecycleReview(
          lateReviewId,
          f.gameId,
          f.sessionId,
          f.lease,
          finalization.executionGeneration,
          finalization.revision,
        );
        const authorized = await pool.connect();
        try {
          await assertMonitorAuthorization(authorized, f.gameId, f.sessionId, f.lease, {
            pendingReviewId: reviewId,
          });
          await assertMonitorAuthorization(authorized, f.gameId, f.sessionId, f.lease, {
            pendingReviewId: lateReviewId,
          });
        } finally {
          authorized.release();
        }
        const rejected = await pool.connect();
        try {
          await rejected.query("BEGIN");
          await assert.rejects(
            insertLifecycleReview(rejected, {
              id: randomUUID(),
              gameId: f.gameId,
              sessionId: f.sessionId,
              sourceLease: f.lease,
              snapshotRevision: finalization.revision,
              targetKind: "transcript",
              model: "monitor",
              promptVersion: "test-v1",
              executionGeneration: finalization.executionGeneration,
              eligibleDrainToken: randomUUID(),
            }),
            /stopped/,
          );
        } finally {
          await rejected.query("ROLLBACK");
          rejected.release();
        }
      } finally {
        await pool.query("DELETE FROM ctf.events WHERE game_id=$1", [f.gameId]);
        await pool.query("DELETE FROM ctf.games WHERE id=$1", [f.gameId]);
      }
    },
  );

  await t.test("an uncleared sibling lease blocks capture without pending reviews", async () => {
    const f = await fixture(pool);
    const siblingId = randomUUID();
    const siblingLease = randomUUID();
    try {
      await pool.query(
        `INSERT INTO ctf.agent_sessions(id,game_id,ordinal,agent_model,agent_effort,system_prompt,lease,lease_until)
         VALUES($1,$2,2,'agent','medium','',$3,now()-interval '1 second')`,
        [siblingId, f.gameId, siblingLease],
      );
      const finalization = await beginFinalization(f.gameId, f.sessionId, f.lease);
      assert.deepEqual(finalization.pendingReviewIds, []);
      assert.deepEqual(
        (await getDrainReadiness(f.gameId, finalization.token, finalization.sessionId))
          .busySessionIds,
        [siblingId],
      );
      const finalReviewId = await review(
        registerLifecycleReview,
        pool,
        f.gameId,
        f.sessionId,
        f.lease,
        finalization.token,
        finalization.revision,
        "submission",
      );
      await pool.query(
        "UPDATE ctf.monitor_reviews SET verdict='allow',completed_at=now() WHERE id=$1",
        [finalReviewId],
      );
      assert.equal(
        await finalizeRun(
          f.gameId,
          finalization.token,
          finalization.revision,
          "captured",
          finalReviewId,
          { sessionId: finalization.sessionId, sourceLease: finalization.sourceLease },
        ),
        null,
      );
      await pool.query("UPDATE ctf.agent_sessions SET lease=NULL,lease_until=NULL WHERE id=$1", [
        siblingId,
      ]);
      assert.equal(
        (await getDrainReadiness(f.gameId, finalization.token, finalization.sessionId)).ready,
        true,
      );
      assert.equal(
        (
          await finalizeRun(
            f.gameId,
            finalization.token,
            finalization.revision,
            "captured",
            finalReviewId,
            { sessionId: finalization.sessionId, sourceLease: finalization.sourceLease },
          )
        )?.status,
        "captured",
      );
    } finally {
      await pool.query("DELETE FROM ctf.events WHERE game_id=$1", [f.gameId]);
      await pool.query("DELETE FROM ctf.games WHERE id=$1", [f.gameId]);
    }
  });

  await t.test("a final allow can persist an ended run when trusted checks fail", async () => {
    const f = await fixture(pool);
    try {
      const finalization = await beginFinalization(f.gameId, f.sessionId, f.lease);
      const finalReviewId = await review(
        registerLifecycleReview,
        pool,
        f.gameId,
        f.sessionId,
        f.lease,
        finalization.token,
        finalization.revision,
        "submission",
      );
      await pool.query(
        "UPDATE ctf.monitor_reviews SET verdict='allow',completed_at=now() WHERE id=$1",
        [finalReviewId],
      );
      const result = await finalizeRun(
        f.gameId,
        finalization.token,
        finalization.revision,
        "ended",
        finalReviewId,
        { sessionId: finalization.sessionId, sourceLease: finalization.sourceLease },
      );
      assert.equal(result?.status, "ended");
      assert.equal(
        (await pool.query("SELECT status FROM ctf.games WHERE id=$1", [f.gameId])).rows[0].status,
        "ended",
      );
    } finally {
      await pool.query("DELETE FROM ctf.events WHERE game_id=$1", [f.gameId]);
      await pool.query("DELETE FROM ctf.games WHERE id=$1", [f.gameId]);
    }
  });

  await t.test("released finalization revokes old command permits", async () => {
    const f = await fixture(pool);
    try {
      const reviewId = randomUUID();
      await pool.query(
        `INSERT INTO ctf.monitor_reviews(id,game_id,session_id,snapshot_revision,target_kind,model,prompt_version,
          verdict,admitted_revision,execution_generation,originating_lease)
         VALUES($1,$2,$3,0,'command','monitor','test-v1','allow',1,0,$4)`,
        [reviewId, f.gameId, f.sessionId, f.lease],
      );
      const client = await pool.connect();
      try {
        await assertExecutionPermit(client, { ...f, reviewId, generation: 0 });
        await pool.query(
          "UPDATE ctf.monitor_reviews SET completed_revision=2,outcome='completed' WHERE id=$1",
          [reviewId],
        );
        await assert.rejects(
          assertExecutionPermit(client, { ...f, reviewId, generation: 0 }),
          /revoked/,
          "completed command outcome cannot be replayed",
        );
        await pool.query(
          "UPDATE ctf.monitor_reviews SET completed_revision=NULL,outcome=NULL WHERE id=$1",
          [reviewId],
        );
      } finally {
        client.release();
      }
      const finalization = await beginFinalization(f.gameId, f.sessionId, f.lease);
      assert.equal(finalization.executionGeneration, 0);
      const released = await releaseFinalization(f.gameId, finalization.token);
      assert.equal(released?.executionGeneration, 1);
      const after = await pool.connect();
      try {
        await assert.rejects(
          assertExecutionPermit(after, { ...f, reviewId, generation: 0 }),
          /revoked/,
        );
        await assert.rejects(
          assertMonitorAuthorization(after, f.gameId, f.sessionId, f.lease, { reviewId }),
          /no longer active/,
          "released generation cannot fund a stale monitor review",
        );
      } finally {
        after.release();
      }
    } finally {
      await pool.query("DELETE FROM ctf.events WHERE game_id=$1", [f.gameId]);
      await pool.query("DELETE FROM ctf.games WHERE id=$1", [f.gameId]);
    }
  });

  await t.test("expired finalization ends the run for caller cleanup", async () => {
    const f = await fixture(pool);
    try {
      await pool.query(
        "UPDATE ctf.agent_sessions SET lease_until=now()+interval '30 seconds' WHERE id=$1",
        [f.sessionId],
      );
      const finalization = await beginFinalization(f.gameId, f.sessionId, f.lease);
      const {
        rows: [deadlines],
      } = await pool.query(
        `SELECT g.finalization_lease_until,s.lease_until FROM ctf.games g
         JOIN ctf.agent_sessions s ON s.game_id=g.id WHERE g.id=$1 AND s.id=$2`,
        [f.gameId, f.sessionId],
      );
      assert.ok(deadlines.finalization_lease_until <= deadlines.lease_until);
      assert.ok(finalization.deadline <= deadlines.lease_until);
      await pool.query(
        "UPDATE ctf.games SET finalization_lease_until=now()-interval '1 second' WHERE id=$1",
        [f.gameId],
      );
      assert.deepEqual(await expireFinalizations(), [f.gameId]);
      assert.equal(
        (await pool.query("SELECT status FROM ctf.games WHERE id=$1", [f.gameId])).rows[0].status,
        "ended",
      );
      assert.equal(await releaseFinalization(f.gameId, finalization.token), null);
    } finally {
      await pool.query("DELETE FROM ctf.events WHERE game_id=$1", [f.gameId]);
      await pool.query("DELETE FROM ctf.games WHERE id=$1", [f.gameId]);
    }
  });
}
