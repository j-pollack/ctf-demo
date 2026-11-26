import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as UI from "../app/game-ui";
import type { GameStatus } from "../lib/types";

const CREATED = "2026-01-01T09:30:00.000Z";
const row = (status: GameStatus, extra: object = {}) =>
  renderToStaticMarkup(
    createElement(UI.RunHistoryRow, {
      run: {
        id: "abcdef123456",
        status,
        agentModel: "vendor/model-a",
        turns: 5,
        blocks: 0,
        budgetMicrodollars: 500_000,
        spentMicrodollars: 1000,
        reservedMicrodollars: 0,
        createdAt: CREATED,
        ...extra,
      },
      onOpen: () => {},
    } as never),
  );

test("a run row reads outcome, facts, date and id, in that order", () => {
  const html = row("captured", { reservedMicrodollars: 84_100 });
  const date = new Date(CREATED).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  assert.equal(
    html,
    `<button class="run-row"><span class="run-outcome" data-band="low">Won</span><span class="run-facts">model-a · 5 turns · $0.0010 spent · $0.0841 held</span><time class="run-date" dateTime="${CREATED}">${date}</time><span class="run-id">ABCDEF12</span></button>`,
  );
  assert.doesNotMatch(html, /RUN |Agent |pending|<strong|<small/);
  assert.match(row("active"), /\$0\.0010 spent<\/span>/, "no held amount, no separator");
});

test("the outcome carries the caught band for caught and blocked and the low band for a win", () => {
  assert.match(row("caught"), /<span class="run-outcome" data-band="caught">Caught<\/span>/);
  assert.match(row("blocked"), /<span class="run-outcome" data-band="caught">Blocked<\/span>/);
  assert.match(row("captured"), /<span class="run-outcome" data-band="low">Won<\/span>/);
  for (const status of ["active", "exhausted", "ended", "finalizing"] as const)
    assert.match(row(status), /<span class="run-outcome">/, status);
});

test("an ended run names how it ended, and a missing model still reads", () => {
  assert.match(row("ended", { submissionCorrect: false }), />Wrong flag<\/span>/);
  assert.match(row("ended", { agentModel: null }), /<span class="run-facts">[^<]* · 5 turns/);
});

test("the intro is the page subtitle, not an empty state", () => {
  assert.equal(
    renderToStaticMarkup(createElement(UI.RunHistoryIntro, { signedIn: true })),
    '<p class="lede">Only you can see your runs.</p>',
  );
  assert.equal(
    renderToStaticMarkup(createElement(UI.RunHistoryIntro, { signedIn: false })),
    '<p class="lede">Sign in to see your runs here.</p>',
  );
});

test("an empty history says how to start, and a full one lists its rows", () => {
  const list = (runs: unknown[]) =>
    renderToStaticMarkup(createElement(UI.RunHistoryList, { runs, onOpen: () => {} } as never));
  assert.equal(list([]), '<p class="empty">No runs yet. Press Play to start one.</p>');
  const html = list([
    {
      id: "aaaaaaaa1",
      status: "caught",
      agentModel: "v/m",
      turns: 1,
      spentMicrodollars: 0,
      reservedMicrodollars: 0,
      createdAt: CREATED,
    },
    {
      id: "bbbbbbbb2",
      status: "captured",
      agentModel: "v/m",
      turns: 2,
      spentMicrodollars: 0,
      reservedMicrodollars: 0,
      createdAt: CREATED,
    },
  ]);
  assert.match(html, /^<div class="run-list">/);
  assert.equal((html.match(/class="run-row"/g) ?? []).length, 2);
  assert.ok(html.indexOf("AAAAAAAA") < html.indexOf("BBBBBBBB"));
  assert.doesNotMatch(html, /No runs yet/);
});
