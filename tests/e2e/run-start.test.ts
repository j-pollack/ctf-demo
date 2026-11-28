import assert from "node:assert/strict";
import { AFTER_TOOL_TEXT, KEYWORDS, REPLIES } from "./agent-script";
import type { Route } from "playwright";
import { journey, waitForAttribute } from "./browser";
import {
  endRun,
  entries,
  instruct,
  memberWithName,
  startRun,
  waitForReviews,
  waitIdle,
} from "./run";
import { pool } from "./stack";

const LIST = REPLIES[KEYWORDS.list];

journey(
  "R1: a member starts a run, instructs it and sees text, a tool call and its output",
  async ({ page }) => {
    await memberWithName(page, "r1");
    const runId = await startRun(page);
    // The page re-reads the run when a response ends and every few seconds. Holding those reads
    // means every entry below can only have arrived through the response's event stream.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const isRead = (url: URL) => url.pathname === `/api/games/${runId}`;
    const hold = async (route: Route) => {
      if (route.request().method() !== "GET") return route.continue();
      await gate;
      return route.continue();
    };
    await page.route(isRead, hold);
    try {
      const pane = page.getByTestId("session-pane");
      const prompt = page.waitForResponse((response) =>
        response.url().endsWith(`/api/games/${runId}/prompt`),
      );
      await instruct(pane, `${KEYWORDS.list} please`);
      const response = await prompt;
      assert.equal(response.status(), 200);
      assert.match(response.headers()["content-type"] ?? "", /^text\/event-stream/);
      await pane.getByTestId("transcript-entry").filter({ hasText: LIST.text }).first().waitFor();
      await pane.getByTestId("entry-command").filter({ hasText: LIST.command! }).waitFor();
      const output = pane.getByTestId("transcript-entry").filter({ hasText: "notes.txt" });
      await waitForAttribute(output, "data-state", "tool");
      await pane.getByTestId("transcript-entry").filter({ hasText: AFTER_TOOL_TEXT }).waitFor();
      release();
      await page.unrouteAll({ behavior: "wait" });
      await waitIdle(pane);

      const { rows } = await pool().query(`SELECT messages FROM ctf.agent_sessions WHERE id=$1`, [
        runId,
      ]);
      const stored = (rows[0].messages as { role: string }[]).filter(
        (message) => message.role !== "system",
      );
      assert.deepEqual(
        stored.map((message) => message.role),
        ["user", "assistant", "toolResult", "assistant"],
      );
      const parts = [[KEYWORDS.list], [LIST.text, LIST.command!], ["notes.txt"], [AFTER_TOOL_TEXT]];
      stored.forEach((message, index) => {
        for (const part of parts[index])
          assert.ok(JSON.stringify(message).includes(part), `message ${index} holds ${part}`);
      });
      assert.ok((await entries(pane)).some((entry) => entry.state === "user"));
      await waitForReviews(runId);
    } finally {
      release();
      await endRun(runId);
    }
  },
);

journey(
  "R2: after a reload the transcript shows the same entries in the same order",
  async ({ page }) => {
    await memberWithName(page, "r2");
    const runId = await startRun(page);
    try {
      const pane = page.getByTestId("session-pane");
      await instruct(pane, `${KEYWORDS.list} please`);
      await pane.getByTestId("transcript-entry").filter({ hasText: AFTER_TOOL_TEXT }).waitFor();
      await waitIdle(pane);
      const before = await entries(pane);
      assert.ok(before.length >= 3, "a user entry, the agent's turn and its follow-up");
      await page.reload();
      await pane.getByTestId("transcript-entry").filter({ hasText: AFTER_TOOL_TEXT }).waitFor();
      await waitIdle(pane);
      assert.deepEqual(await entries(pane), before);
      await waitForReviews(runId);
    } finally {
      await endRun(runId);
    }
  },
);
