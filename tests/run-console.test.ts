import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RunConsole, type RunConsoleProps } from "../app/run-console";
import { createSessionUIState } from "../app/session-ui-state";
import { fetched, run, session, transcript } from "./fixtures/console-runs";
import type { PublicGame } from "../lib/types";

const noop = () => {};
const props = (game: PublicGame, extra: Partial<RunConsoleProps> = {}): RunConsoleProps => ({
  game,
  sessions: game.sessions,
  sessionViews: Object.fromEntries(
    game.sessions.map((item) => [item.id, fetched(item.id, transcript(2, item.ordinal * 100))]),
  ),
  focusedId: game.sessions[0].id,
  shownIds: game.sessions.map((item) => item.id),
  inspector: "closed",
  workbenchRef: null,
  seen: {},
  editable: game.status === "active",
  busy: false,
  streamingIds: [],
  creatingSession: false,
  newRunDisabled: false,
  outcome: {
    detailError: "",
    detailLoading: false,
    stage: "",
    canContinue: false,
    continueDisabled: false,
  },
  pane: {
    onDraftChange: noop,
    onSystemDraftChange: noop,
    onSend: noop,
    onStop: noop,
    onRetry: noop,
    onDismissError: noop,
    onCopy: noop,
  },
  onFocusSession: noop,
  onToggleDetails: noop,
  onCloseInspector: noop,
  onNewRun: noop,
  onContinue: noop,
  onRetryDetail: noop,
  ...extra,
});
const render = (game: PublicGame, extra: Partial<RunConsoleProps> = {}) =>
  renderToStaticMarkup(createElement(RunConsole, props(game, extra)));
const sessions = (count: number) => Array.from({ length: count }, (_, index) => session(index + 1));
const count = (html: string, pattern: RegExp) => (html.match(pattern) ?? []).length;

test("four sessions at capacity four render four panes", () => {
  const html = render(run(sessions(4)));
  assert.equal(count(html, /<section class="pane"/g), 4);
  assert.match(html, /<div class="deck" style="--panes:4">/);
  assert.doesNotMatch(html, /class="outcome"|class="inspector"|data-inspector/);
});

test("ten sessions at capacity three render three panes and ten chips", () => {
  const game = run(sessions(10));
  const html = render(game, {
    shownIds: ["session-1", "session-2", "session-9"],
    focusedId: "session-9",
  });
  assert.equal(count(html, /<section class="pane"/g), 3);
  assert.equal(count(html, /class="chip"/g), 10);
  assert.match(html, /<section class="pane" id="pane-session-9"[^>]*data-focused="true"/);
});

test("a caught run shows one outcome strip with the caught session, and no pane repeats it", () => {
  const game = run(sessions(4), {
    status: "caught",
    caughtSessionId: "session-4",
    caughtSessionOrdinal: 4,
    caughtReason: "The agent printed the flag.",
  });
  const html = render(game);
  assert.equal(count(html, /class="outcome"/g), 1);
  assert.equal(count(html, /Session 4 caused the catch\./g), 1);
  assert.equal(count(html, /Investigator reason: The agent printed the flag\./g), 1);
  assert.match(html, /<button type="button" class="link outcome-session">Show session 4<\/button>/);
  const panes = html.slice(html.indexOf('<div class="deck"'));
  assert.doesNotMatch(panes, /terminal loss|caused the catch/);
  assert.doesNotMatch(html, /<textarea id="prompt-/);
});

test("a captured run keeps the win line with its turn count in the strip", () => {
  const html = render(run(sessions(2), { status: "captured", turns: 9 }));
  assert.match(html, /spent over 9 turns\./);
  assert.equal(count(html, /class="outcome"/g), 1);
});

test("an open inspector is a column or covers an inert deck", () => {
  const column = render(run(sessions(2)), { inspector: "column" });
  assert.match(column, /<div class="workbench" data-inspector="column">/);
  assert.match(column, /<aside class="inspector" id="run-inspector"/);
  assert.doesNotMatch(column, /inert/);
  const overlay = render(run(sessions(2)), { inspector: "overlay" });
  assert.match(overlay, /data-inspector="overlay"/);
  assert.match(overlay, /<div class="deck" style="--panes:2" inert="">/);
});

test("an unfetched pane shows its loader beside loaded panes", () => {
  const game = run(sessions(2));
  const base = props(game);
  const html = render(game, {
    sessionViews: { ...base.sessionViews, "session-2": createSessionUIState({ id: "session-2" }) },
  });
  assert.match(html, /Loading session 2…/);
  assert.equal(count(html, /mission-intro/g), 0);
});
