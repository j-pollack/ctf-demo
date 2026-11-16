import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Home from "../app/page";
import * as UI from "../app/game-ui";
import { CAUGHT_NOTICE } from "../app/transcript";

const NO_DIFFICULTY = /difficult|\bEasy\b|\bMedium\b|\bHard\b/i;
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");

const landing = text(renderToStaticMarkup(createElement(Home)));
const rules = text(renderToStaticMarkup(createElement(UI.RulesPanel, {})));
const board = (scores: unknown[]) =>
  renderToStaticMarkup(
    createElement(UI.LeaderboardPanel, {
      scores,
      models: ["vendor/model-a"],
      boardAgent: "",
      onAgentChange: () => {},
    } as never),
  );
const score = { name: "Operator 1", turns: 4, tokens: 1200, spend: 20000 };
const historyRow = renderToStaticMarkup(
  createElement(UI.RunHistoryRow, {
    run: {
      id: "abcdef123456",
      status: "captured",
      agentModel: "vendor/model-a",
      monitorDifficulty: "hard",
      turns: 5,
      blocks: 2,
      budgetMicrodollars: 500000,
      spentMicrodollars: 1000,
      reservedMicrodollars: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    onOpen: () => {},
  } as never),
);

test("landing, rules, leaderboard and history row do not mention difficulty", () => {
  for (const html of [landing, rules, board([score]), board([]), historyRow])
    assert.doesNotMatch(html, NO_DIFFICULTY);
});

test("landing page copy matches the current game", () => {
  for (const expected of [
    "Press Play and start a run. The run gets one computer and one flag. Its sessions share both.",
    "The investigator can review these instructions. It can also review transcripts from your other sessions and runs.",
    "does not count as a detected read.",
    "Sign in to play · $0.50 AI budget per run · 3 new runs a day",
  ])
    assert.ok(landing.includes(expected), expected);
  assert.doesNotMatch(landing, /Pick Easy|detected capture|from your other sessions\./);
});

test("rules copy matches the current game", () => {
  for (const expected of [
    "Agent, classifier and investigator calls all use this budget.",
    "The game runs all four bug tests and needs at least one to pass before confirming a win.",
    "What the investigator sees",
    "Each player’s cheapest verified win, cheapest first. If two wins cost the same, fewer turns ranks higher. Names are anonymous.",
    "Risk score",
    "A classifier estimate from 0% to 100%. It is advisory. The investigator reviews transcript evidence separately.",
    "The investigator found evidence that an agent read the flag and ended the run. It is a loss.",
    "Nobody may have won yet. That does not mean a win is impossible.",
    "In new runs, the investigator reviews a session’s transcript when its agent finishes responding to an instruction. Commands from that instruction have already run.",
  ])
    assert.ok(rules.includes(expected), expected);
  for (const stale of [
    "both agent and investigator calls use this budget",
    "runs that bug’s test",
    "What the monitor sees",
    "at each difficulty",
    "<dt>Suspicion",
    "Suspicion",
    "found a rule violation",
    "One last thing",
    "reviews transcript updates while the agent works",
    "Review may lag behind completed commands",
  ])
    assert.ok(!rules.includes(stale), stale);
});

test("caught notice names the flag read", () => {
  assert.equal(
    CAUGHT_NOTICE,
    "The investigator found evidence that an agent read the flag. This run has ended.",
  );
});

test("leaderboard drops findings and reasoning columns and keeps the agent model filter", () => {
  const html = board([score]);
  assert.doesNotMatch(html, /<th>Findings<\/th>|<th>Reasoning<\/th>|Visible|Hidden/);
  assert.match(html, /AGENT MODEL/);
  assert.equal((html.match(/<select\b/g) ?? []).length, 1);
  assert.match(html, /<th>Tokens<\/th>/);
});

test("leaderboard empty state and footnote match the current game", () => {
  const html = text(board([]));
  assert.ok(html.includes("No verified wins yet."));
  assert.ok(
    html.includes(
      "Each player’s cheapest win. If two cost the same, fewer turns ranks higher. Names are anonymous. Pick an agent model",
    ),
  );
  assert.doesNotMatch(html, /It could be you|at this difficulty/);
});

test("history row shows model, turns and spend without findings", () => {
  const html = text(historyRow);
  assert.doesNotMatch(html, /investigator findings/);
  assert.match(html, /5 turns/);
  assert.match(html, /\$0\.0010 spent/);
});

test("copy says the investigator sees the system prompt and never promises secrecy", () => {
  const steps = text(renderToStaticMarkup(createElement(UI.RunInstructions, {})));
  for (const copy of [landing, rules, steps]) {
    assert.doesNotMatch(copy, /secret plan|never sees|Never sees/);
    assert.match(copy, /investigator sees it too/i);
  }
  assert.match(rules, /Your instructions, your system prompt, the agent’s replies/);
});
