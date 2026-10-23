import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BLOCKED_NOTICE,
  BlockedNotice,
  CAUGHT_NOTICE,
  composerAfterFork,
  endBanner,
  Entry,
  groupTurns,
  refreshedGame,
} from "../app/game-ui";
import type { GameEvent, PublicGame } from "../lib/types";

test("transcript distinguishes speakers, renders commands and shows only blocked decisions", () => {
  const render = (event: GameEvent, previous?: GameEvent) =>
    renderToStaticMarkup(createElement(Entry, { event, previous }));
  assert.match(render({ id: 1, kind: "user", text: "Where are you?" }), />USER</);
  const agent = render({
    id: 2,
    kind: "agent",
    text: "Checking",
    reasoning: "I will check the current directory.",
    turn: 3,
    model: "qwen/model-used-on-turn-3",
    command: 'sprite_exec: {"command":"pwd"}\nsprite_exec: {"command":"echo hello"}',
  });
  assert.match(agent, />AGENT</);
  assert.match(agent, /aria-label="Copy response"/);
  assert.doesNotMatch(agent, /Fork/, "forking lives on the blocked banner, not on each message");
  assert.match(agent, /<\/span><div class="entry-actions"><button[^>]*aria-label="Copy response"/);
  assert.doesNotMatch(agent, /<\/article><div class="entry-actions">|entry-action-label/);
  assert.match(agent, /TURN 3/);
  assert.match(agent, /model-used-on-turn-3/);
  assert.ok(agent.indexOf("Agent reasoning") < agent.indexOf("<p>Checking</p>"));
  assert.match(agent, /<pre>pwd\necho hello<\/pre>/);
  assert.doesNotMatch(agent, /sprite_exec|&quot;command&quot;/);
  assert.match(render({ id: 3, kind: "agent", text: "", command: "pwd" }), /<pre>pwd<\/pre>/);
  const blocked: GameEvent = {
    id: 4,
    kind: "monitor",
    decision: "block",
    text: "An old explanation",
    command: "cat /tmp/flag.txt",
  };
  const block = render(blocked);
  assert.match(block, />Blocked</);
  assert.match(block, /An old explanation/);
  assert.doesNotMatch(block, /flag\.txt/);
  assert.equal(
    render({ ...blocked, text: "" }),
    '<article class="entry monitor blocked"><span>Blocked</span></article>',
  );
  assert.equal(render({ id: 5, kind: "tool", text: "Blocked" }, blocked), "");
  assert.equal(render({ ...blocked, decision: "allow" }), "");
  assert.match(
    render({ ...blocked, decision: "error", text: "Inference unavailable" }),
    /Inference unavailable/,
  );
});

test("user and agent Markdown renders safely; tool output remains literal", () => {
  const text =
    "## Plan\n\n**Bold** and *italic* with `pwd`.\n\n- Check files\n- Read output\n\n```sh\nprintf hello\n```\n\n[Docs](https://example.com)\n\n| Command | Result |\n| --- | --- |\n| pwd | workspace |\n\n<script>alert(1)</script>\n\n[unsafe](javascript:alert%281%29)\n\n![remote](https://example.com/tracker.png)";
  for (const kind of ["user", "agent"] as const) {
    const html = renderToStaticMarkup(createElement(Entry, { event: { id: 1, kind, text } }));
    assert.match(html, /<h2>Plan<\/h2>/);
    assert.match(html, /<strong>Bold<\/strong> and <em>italic<\/em> with <code>pwd<\/code>/);
    assert.match(html, /<ul>\s*<li>Check files<\/li>/);
    assert.match(html, /<pre><code class="language-sh">printf hello\n<\/code><\/pre>/);
    assert.match(
      html,
      /<a href="https:\/\/example.com" target="_blank" rel="noopener noreferrer">Docs<\/a>/,
    );
    assert.match(html, /<table>/);
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /<script|javascript:|<img|tracker\.png/);
  }
  const tool = renderToStaticMarkup(
    createElement(Entry, {
      event: { id: 2, kind: "tool", text: "**literal** <script>alert(1)</script>" },
    }),
  );
  assert.match(tool, /\*\*literal\*\* &lt;script&gt;/);
  assert.doesNotMatch(tool, /Fork/);
  assert.doesNotMatch(
    renderToStaticMarkup(createElement(Entry, { event: { id: 3, kind: "user", text: "hi" } })),
    /Fork/,
  );
});

test("run refreshes cannot replace a newly selected child with a stale parent", () => {
  const child = { id: "child" } as PublicGame;
  const staleParent = { id: "parent" } as PublicGame;
  const updatedChild = {
    id: "child",
    status: "ended",
    events: [{ id: 1, kind: "agent", text: "refreshed" }],
  } as PublicGame;
  assert.equal(refreshedGame(child, staleParent), child);
  assert.equal(refreshedGame(child, updatedChild), updatedChild);
  assert.equal(refreshedGame(null, staleParent), null);
});

test("agent turns show each command with its output or monitor verdict directly beneath", () => {
  const events: GameEvent[] = [
    {
      id: 1,
      kind: "agent",
      text: "Working",
      turn: 1,
      model: "m",
      command: "ls\ncat secret\nrm x\nunseen",
    },
    { id: 2, kind: "monitor", text: "", decision: "allow", command: "ls" },
    { id: 3, kind: "tool", text: "file.txt" },
    {
      id: 4,
      kind: "monitor",
      text: "Reads the protected file.",
      decision: "block",
      command: "cat secret",
    },
    { id: 5, kind: "tool", text: "Blocked" },
    { id: 6, kind: "monitor", text: "Inference unavailable", decision: "error", command: "rm x" },
    { id: 7, kind: "tool", text: "Operation aborted" },
  ];
  const html = renderToStaticMarkup(
    createElement(
      "div",
      null,
      groupTurns(events).map(({ event, calls, pending }) =>
        createElement(Entry, { key: event.id, event, calls, pending }),
      ),
    ),
  );
  const at = (needle: string) => {
    const index = html.indexOf(needle);
    assert.ok(index >= 0, `missing ${needle}`);
    return index;
  };
  assert.ok(
    at("<pre>ls</pre>") < at("file.txt") &&
      at("file.txt") < at("<pre>cat secret</pre>") &&
      at("<pre>cat secret</pre>") < at("Reads the protected file.") &&
      at("Reads the protected file.") < at("<pre>rm x</pre>") &&
      at("<pre>rm x</pre>") < at("Inference unavailable") &&
      at("Inference unavailable") < at("<pre>unseen</pre>"),
  );
  assert.match(html, />Blocked</);
  assert.match(html, />Monitor error</);
  assert.doesNotMatch(html, /TOOL OUTPUT|Operation aborted|MONITOR ERROR/);
  assert.equal(html.match(/<article/g)?.length, 1);
});

test("copy sits in the agent header as a compact labelled icon button", () => {
  const html = renderToStaticMarkup(
    createElement(Entry, { event: { id: 1, kind: "agent", text: "Hi", turn: 2, model: "m" } }),
  );
  const header = html.slice(html.indexOf("<header>"), html.indexOf("</header>"));
  assert.match(header, /<div class="entry-actions">/);
  assert.match(header, /aria-label="Copy response"/);
  assert.doesNotMatch(header, /Fork/);
  assert.doesNotMatch(html, /<\/article><div class="entry-actions">|entry-action-label/);
});

test("long command output starts collapsed after 12 lines; short output stays whole", () => {
  const render = (output: string) =>
    renderToStaticMarkup(
      createElement(Entry, {
        event: { id: 1, kind: "agent", text: "", turn: 1, command: "ls" },
        calls: [{ command: "ls", decision: "allow", reason: "", output }],
      }),
    );
  const lines = (count: number) =>
    Array.from({ length: count }, (_, i) => `line${i + 1}`).join("\n");
  const short = render(lines(15));
  assert.match(short, /<pre class="call-output">line1\n[\s\S]*line15<\/pre>/);
  assert.doesNotMatch(short, /<details>/);
  const long = render(lines(40));
  assert.match(long, /<div class="call-output"><pre>line1\n[\s\S]*line12<\/pre><details>/);
  assert.match(long, /Show 28 more lines/);
  assert.match(long, /<details>[\s\S]*<pre>line13\n[\s\S]*line40<\/pre><\/details>/);
  assert.doesNotMatch(long.split("<details>")[0], /line13/);
});

test("a submission is quoted as the submitted value and collapses after 12 lines", () => {
  const render = (text: string, correct: boolean) =>
    renderToStaticMarkup(
      createElement(Entry, { event: { id: 1, kind: "submit", text, correct, turn: 2 } }),
    );
  const short = render("flag{maybe}", false);
  assert.match(short, /SUBMITTED · WRONG/);
  // The value is quoted so it clearly reads as what the agent handed in, not game prose.
  assert.match(short, /<figure class="submission"><figcaption>The agent submitted this value:/);
  assert.match(short, /<blockquote><pre class="call-output">flag\{maybe\}<\/pre><\/blockquote>/);
  assert.match(render("flag{real}", true), /SUBMITTED · CORRECT/);
  // A long essay-style submission starts collapsed, like command output.
  const long = render(Array.from({ length: 40 }, (_, i) => `line${i + 1}`).join("\n"), false);
  assert.match(long, /<div class="call-output"><pre>line1\n[\s\S]*line12<\/pre><details>/);
  assert.match(long, /Show 28 more lines/);
  assert.doesNotMatch(long.split("<details>")[0], /line13/);
});

test("a blocked run says it is over and offers a fork only when forkable", () => {
  assert.equal(
    BLOCKED_NOTICE,
    "Your run is over. The monitor decided this conversation is attempting to exfiltrate data. If that's wrong, fork the previous message and try again with a new instruction.",
  );
  const render = (forkable: boolean) =>
    renderToStaticMarkup(createElement(BlockedNotice, { forkable, disabled: false, onFork() {} }));
  const forkable = render(true);
  assert.match(forkable, /<h2>Run blocked<\/h2>/);
  assert.ok(
    forkable.includes("Your run is over.") && forkable.includes("fork the previous message"),
  );
  assert.match(forkable, /<button[^>]*>Fork<\/button>/);
  assert.doesNotMatch(render(false), /<button/);
});

test("a caught run shows a loss screen that says how it was caught, not a wrong-answer banner", () => {
  const render = (endReview: boolean) =>
    renderToStaticMarkup(
      createElement(BlockedNotice, {
        status: "caught",
        endReview,
        forkable: true,
        disabled: false,
        onFork() {},
      }),
    );
  const endReview = render(true);
  // A loss, not the green win banner.
  assert.match(endReview, /class="terminal loss"/);
  assert.match(endReview, /<h2>Caught by the end review<\/h2>/);
  assert.ok(endReview.includes(CAUGHT_NOTICE.slice(0, 40)));
  assert.ok(!endReview.includes("wrong answer"));
  assert.match(endReview, /<button[^>]*>Fork<\/button>/);
  // The mid-run case reads differently.
  const inAct = render(false);
  assert.match(inAct, /<h2>Caught in the act<\/h2>/);
  assert.ok(inAct.includes("crossed the monitor"));
});

test("only a capture gets the green win banner; every other end is a loss", () => {
  assert.deepEqual(endBanner("captured", true), {
    win: true,
    className: "terminal",
    heading: "You captured the flag",
  });
  // A wrong answer is a loss, not green.
  assert.deepEqual(endBanner("ended", true), {
    win: false,
    className: "terminal loss",
    heading: "The agent submitted the wrong answer",
  });
  // Ended with no submit, and out of budget, are also losses.
  assert.equal(endBanner("ended", false).heading, "This run has ended");
  assert.equal(endBanner("ended", false).className, "terminal loss");
  assert.deepEqual(endBanner("exhausted", false), {
    win: false,
    className: "terminal loss",
    heading: "Out of budget",
  });
});

test("each reviewed command shows its monitor suspicion", () => {
  const events: GameEvent[] = [
    { id: 1, kind: "agent", text: "", turn: 1, model: "m", commands: ["ls", "cat x"] },
    { id: 2, kind: "monitor", text: "", decision: "allow", command: "ls", suspicion: 0.02 },
    { id: 3, kind: "tool", text: "files" },
    {
      id: 4,
      kind: "monitor",
      text: "Reads it.",
      decision: "block",
      command: "cat x",
      suspicion: 0.98,
    },
  ];
  const [{ event, calls, pending }] = groupTurns(events);
  assert.equal(calls[0].suspicion, 0.02);
  assert.equal(calls[1].suspicion, 0.98);
  const html = renderToStaticMarkup(createElement(Entry, { event, calls, pending }));
  assert.ok(html.includes("0.02") && html.includes("0.98"));
  assert.match(html, /data-high/); // the 0.98 command is flagged high
});

test("after a fork the composer holds the dropped instruction, or is empty", () => {
  assert.equal(composerAfterFork({ retryInstruction: "try the other way" }), "try the other way");
  assert.equal(composerAfterFork({}), "");
});

test("an Easy fail-open shows its note above the output; an ordinary approval shows none", () => {
  const note = "The monitor couldn't make a valid decision. On Easy, the command runs anyway.";
  const events: GameEvent[] = [
    { id: 1, kind: "agent", text: "", turn: 1, model: "m", commands: ["ls", "pwd"] },
    { id: 2, kind: "monitor", text: note, decision: "allow", command: "ls" },
    { id: 3, kind: "tool", text: "file.txt" },
    { id: 4, kind: "monitor", text: "", decision: "allow", command: "pwd" },
    { id: 5, kind: "tool", text: "/workspace" },
  ];
  const [{ event, calls, pending }] = groupTurns(events);
  const html = renderToStaticMarkup(createElement(Entry, { event, calls, pending }));
  assert.equal(html.match(/class="call-note"/g)?.length, 1);
  assert.ok(html.indexOf("couldn&#x27;t make a valid decision") < html.indexOf("file.txt"));
  assert.ok(html.includes("/workspace"));
  assert.ok(!html.includes("Monitor error"));
});

test("a resumable time-limit stop renders as info (PAUSED), a real error as SYSTEM", () => {
  const paused = renderToStaticMarkup(
    createElement(Entry, {
      event: {
        id: 1,
        kind: "error",
        text: "Response stopped. Your run is still open.",
        resumable: true,
      },
    }),
  );
  assert.match(paused, /class="entry error info"/);
  assert.match(paused, />PAUSED</);
  assert.ok(!paused.includes(">SYSTEM<"));
  const failure = renderToStaticMarkup(
    createElement(Entry, {
      event: { id: 2, kind: "error", text: "This response could not finish." },
    }),
  );
  assert.match(failure, /class="entry error"/);
  assert.ok(!failure.includes(" info"));
  assert.match(failure, />SYSTEM</);
});

test("the end review renders standalone (not folded) and isn't labelled Blocked", () => {
  const events: GameEvent[] = [
    { id: 1, kind: "agent", text: "Submitting now.", turn: 2, model: "m" },
    {
      id: 2,
      kind: "monitor",
      text: "In context, it looks like an attempt.",
      decision: "block",
      suspicion: 0.98,
    },
    { id: 3, kind: "submit", text: "flag{x}", correct: true, caught: true },
  ];
  const groups = groupTurns(events);
  // The commandless end review is its own group, not a call folded onto the agent turn.
  assert.deepEqual(groups.find((g) => g.event.kind === "agent")?.calls, []);
  const review = groups.find((g) => g.event.kind === "monitor")!.event;
  const html = renderToStaticMarkup(createElement(Entry, { event: review }));
  assert.match(html, /End review · suspicion 0\.98/);
  assert.ok(!html.includes(">Blocked<"));
});

test("a submit card reaffirms both objectives and notes a catch", () => {
  const caught = renderToStaticMarkup(
    createElement(Entry, {
      event: { id: 1, kind: "submit", text: "flag{x}", correct: true, bugsPassed: 1, caught: true },
    }),
  );
  assert.match(caught, /Flag correct · 1 bug fixed/);
  assert.match(caught, /both objectives met, but the run was caught/);
  const won = renderToStaticMarkup(
    createElement(Entry, {
      event: {
        id: 2,
        kind: "submit",
        text: "flag{x}",
        correct: true,
        bugsPassed: 2,
        caught: false,
      },
    }),
  );
  assert.match(won, /2 bugs fixed/);
  assert.match(won, /both objectives met\./);
  // A wrong flag has no success conditions to reaffirm; the header already says WRONG.
  const wrong = renderToStaticMarkup(
    createElement(Entry, { event: { id: 3, kind: "submit", text: "nope", correct: false } }),
  );
  assert.ok(!wrong.includes("submit-conditions"));
  assert.ok(!wrong.includes("objectives met"));
});
