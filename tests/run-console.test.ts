import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RunConsole, type RunConsoleProps } from "../app/run-console";
import { createSessionUIState } from "../app/session-ui-state";
import { PENDING_SESSION } from "../app/session-layout";
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
  pendingOrdinal: null,
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

test("a session being created shows a pending chip and pane at once", () => {
  const game = run(sessions(4));
  const html = render(game, {
    shownIds: ["session-1", "session-3", "session-4", PENDING_SESSION],
    focusedId: "session-1",
    pendingOrdinal: 5,
    creatingSession: true,
    onCreateSession: noop,
  });
  assert.match(
    html,
    /<button type="button" class="chip" data-pending="true" aria-label="Session 5, starting" tabindex="-1" disabled="">5<\/button>/,
  );
  const pane = html.slice(html.indexOf('id="pane-pending-session"'));
  assert.match(pane, /<h2 id="pane-title-pending-session">Session 5<\/h2>/);
  assert.match(
    pane,
    /<p role="status" class="stage"><i aria-hidden="true"><\/i>Starting session 5…<\/p>/,
  );
  assert.doesNotMatch(pane.slice(0, pane.indexOf("</section>")), /<form|<textarea/);
  assert.match(
    html,
    /<button type="button" class="session-add"[^>]*aria-disabled="true" aria-busy="true"/,
  );
  assert.equal(count(html, /<section class="pane"/g), 4);
  assert.doesNotMatch(render(game), /data-pending|Starting session/);
});

test("only an overlay inspector has a footer, and it only closes the inspector", () => {
  const overlay = render(run(sessions(2)), { inspector: "overlay" });
  const footer = overlay.slice(overlay.indexOf('<footer class="inspector-footer">'));
  assert.match(
    footer,
    /^<footer class="inspector-footer"><button type="button" class="close-details">Close details<\/button><\/footer>/,
  );
  assert.doesNotMatch(
    render(run(sessions(2)), { inspector: "column" }),
    /inspector-footer|Close details/,
  );
});

test("New run is offered once, in the run bar, whatever the run state or inspector mode", () => {
  const caught = run(sessions(2), {
    status: "caught",
    caughtSessionOrdinal: 1,
    caughtSessionId: "session-1",
  });
  for (const html of [
    render(run(sessions(2))),
    render(run(sessions(2)), { inspector: "overlay" }),
    render(caught),
    render(caught, { inspector: "overlay" }),
  ]) {
    assert.equal((html.match(/>New run<\/button>/g) ?? []).length, 1);
    const bar = html.slice(html.indexOf('class="run-actions"'), html.indexOf('class="workbench"'));
    assert.match(bar, /class="new-run"[^>]*>New run<\/button>/);
  }
});

test("the current chip and the focused pane always name the same session while one is pending", () => {
  const game = run(sessions(4));
  const pendingProps = {
    shownIds: ["session-1", "session-3", "session-4", PENDING_SESSION],
    pendingOrdinal: 5,
    creatingSession: true,
    onCreateSession: noop,
  };
  const current = (html: string) =>
    [...html.matchAll(/<button[^>]*class="chip"[^>]*aria-current="true"[^>]*>(\d+)/g)].map(
      (m) => m[1],
    );
  const focused = (html: string) =>
    [...html.matchAll(/<section class="pane" id="pane-([^"]+)"[^>]*data-focused="true"/g)].map(
      (m) => m[1],
    );
  const pending = render(game, { ...pendingProps, focusedId: PENDING_SESSION });
  assert.deepEqual(current(pending), ["5"], "the pending chip is current");
  assert.deepEqual(focused(pending), [PENDING_SESSION]);
  const moved = render(game, { ...pendingProps, focusedId: "session-3" });
  assert.deepEqual(current(moved), ["3"]);
  assert.deepEqual(focused(moved), ["session-3"], "the pending pane stays without the focus bar");
  assert.match(moved, /id="pane-pending-session"/);
});

test("Add session stays focusable while a session is being created", () => {
  const html = render(run(sessions(2)), {
    creatingSession: true,
    pendingOrdinal: 3,
    onCreateSession: noop,
  });
  const add = html.match(/<button type="button" class="session-add"[^>]*>/)![0];
  assert.match(add, /aria-disabled="true"/);
  assert.match(add, /aria-busy="true"/);
  assert.doesNotMatch(add, / disabled=""/);
});

test("while the first instruction is in flight, empty sibling panes no longer show the intro", () => {
  const game = run([session(1, { turns: 0 }), session(2, { turns: 0 })], { turns: 0 });
  const views = {
    "session-1": {
      ...fetched("session-1", [{ id: -1, kind: "user" as const, text: "go" }]),
      busy: true,
    },
    "session-2": fetched("session-2", []),
  };
  const html = render(game, { sessionViews: views });
  assert.doesNotMatch(html, /Fix a bug, then submit the flag/);
  assert.match(html, /No instructions yet\./);
  const fresh = render(game, {
    sessionViews: { "session-1": fetched("session-1", []), "session-2": fetched("session-2", []) },
  });
  assert.equal(count(fresh, /Fix a bug, then submit the flag/g), 2);
});
