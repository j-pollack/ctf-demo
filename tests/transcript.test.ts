import { REFUSED_PLACEHOLDER_TEXT } from "../lib/text-screen";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { refreshedGame } from "../app/game-ui";
import {
  BLOCKED_NOTICE,
  BlockedNotice,
  CAUGHT_NOTICE,
  endBanner,
  Entry,
  groupTurns,
  REFUSED_NOTE,
} from "../app/transcript";
import type { GameEvent, PublicGame } from "../lib/types";

test("transcript distinguishes speakers, renders commands and shows only blocked decisions", () => {
  const render = (event: GameEvent, previous?: GameEvent) =>
    renderToStaticMarkup(createElement(Entry, { event, previous, showModel: true }));
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
  assert.doesNotMatch(
    renderToStaticMarkup(
      createElement(Entry, { event: { id: 2, kind: "agent", text: "", turn: 3, model: "qwen/m" } }),
    ),
    /turn-model|qwen\/m/,
    "a turn does not name its model unless asked to",
  );
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
  assert.match(block, />Investigator block</);
  assert.match(block, /An old explanation/);
  assert.doesNotMatch(block, /flag\.txt/);
  assert.equal(
    render({ ...blocked, text: "" }),
    '<article class="entry monitor blocked"><span>Investigator block</span></article>',
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
  assert.match(html, />Investigation error</);
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

test("HTTP receipts are generic while pending and historical tool submissions remain visible", () => {
  const http = renderToStaticMarkup(
    createElement(Entry, {
      event: {
        id: 1,
        kind: "submit",
        text: "",
        submissionTransport: "http",
      } as GameEvent,
    }),
  );
  assert.match(http, /SUBMITTED/);
  assert.match(http, /review/);
  assert.doesNotMatch(http, /WRONG|CORRECT|submitted this value|Flag wrong|flag\{/);
  assert.equal(
    endBanner("ended", { submissionTransport: "http" } as GameEvent).heading,
    "This run has ended",
  );
  const legacy = renderToStaticMarkup(
    createElement(Entry, {
      event: { id: 2, kind: "submit", text: "flag{old}", correct: false },
    }),
  );
  assert.match(legacy, /flag\{old\}|SUBMITTED · WRONG/);
});

test("a terminal HTTP receipt points to the final outcome without repeating a pending claim", () => {
  const html = renderToStaticMarkup(
    createElement(Entry, {
      event: { id: 1, kind: "submit", text: "", submissionTransport: "http" },
      runStatus: "captured",
    }),
  );
  assert.match(html, /Submission received\. See run outcome/);
  assert.doesNotMatch(html, /pending review|submitted this value|CORRECT|WRONG/);
});

test("a blocked run says it is over and offers no action", () => {
  assert.equal(BLOCKED_NOTICE, "The investigator stopped an action and ended this run.");
  const blocked = renderToStaticMarkup(createElement(BlockedNotice, {}));
  assert.match(blocked, /<h2>Run blocked<\/h2>/);
  assert.ok(blocked.includes("ended this run"));
  assert.doesNotMatch(blocked, /fork|<button/i);
});

test("a caught run without command metadata uses generic copy, not a submission claim", () => {
  const render = (blockedCommand = false) =>
    renderToStaticMarkup(
      createElement(BlockedNotice, {
        status: "caught",
        blockedCommand,
      }),
    );
  const endReview = render(true);
  // A loss, not the green win banner.
  assert.match(endReview, /class="terminal loss"/);
  assert.match(endReview, /<h2>Caught in the act<\/h2>/);
  assert.ok(!endReview.includes(CAUGHT_NOTICE));
  assert.ok(!endReview.includes("Wrong flag"));
  const unknownStage = render();
  assert.match(unknownStage, /<h2>Run caught<\/h2>/);
  assert.ok(unknownStage.includes(CAUGHT_NOTICE));
  assert.ok(!unknownStage.includes("correct flag"));
});

test("a catch banner gives the investigator's reason once, in place of the generic line", () => {
  const banner = (extra = {}) =>
    renderToStaticMarkup(
      createElement(BlockedNotice, {
        status: "caught",
        caughtSessionId: "session-uuid",
        caughtSessionOrdinal: 2,
        caughtReason: "The session prepared a flag read.",
        ...extra,
      }),
    );
  const single = banner();
  // The reason is the only verdict text; the last line points at Report.
  assert.match(
    single,
    /<h2>Run caught<\/h2><p>The session prepared a flag read\.<\/p><p>Think the monitor got this wrong\? Press Report and tell us\.<\/p><\/div>$/,
  );
  assert.ok(!single.includes(CAUGHT_NOTICE), "the reason replaces the generic line");
  assert.doesNotMatch(single, /Investigator reason:|caused the catch|Show session/);
  const several = banner({ multiSession: true, onShowSession: () => {} });
  assert.match(several, /Session 2 caused the catch\./);
  assert.match(
    several,
    /<button type="button" class="link outcome-session">Show session 2<\/button>/,
  );
  assert.doesNotMatch(banner({ multiSession: true }), /Show session/, "no link when it is shown");
  assert.ok(banner({ caughtReason: null }).includes(CAUGHT_NOTICE), "no reason: the generic line");
  assert.doesNotMatch(single, /classifier|risk|Investigator review/i, "the outcome is the reason");
});

test("a refused placeholder shows what the player sent, as plain text, with the refusal under it", () => {
  const placeholder: GameEvent = {
    id: 4,
    kind: "user",
    text: "[A submission was refused by the jailbreak screen. Its text is withheld.]",
    refused: true,
    refusedTextIds: ["a", "b"],
  };
  const texts = [
    { id: "b", kind: "system_prompt" as const, text: "refused system text B", flagged: false },
    { id: "a", kind: "instruction" as const, text: "refused <b>text</b> A", flagged: true },
    { id: "c", kind: "instruction" as const, text: "another submission", flagged: true },
  ];
  const html = renderToStaticMarkup(
    createElement(Entry, { event: placeholder, refusedTexts: texts }),
  );
  assert.match(html, />USER</);
  assert.match(
    html,
    /<pre>refused &lt;b&gt;text&lt;\/b&gt; A<\/pre>.*System prompt.*<pre>refused system text B<\/pre>/,
  );
  assert.ok(
    html.indexOf(REFUSED_NOTE.replaceAll("'", "&#x27;")) > html.indexOf("system text B"),
    "the note is beneath",
  );
  assert.doesNotMatch(html, /another submission|withheld/);
  const withheld = renderToStaticMarkup(createElement(Entry, { event: placeholder }));
  assert.match(withheld, /Its text is withheld/, "a viewer without the texts sees the placeholder");
  assert.doesNotMatch(withheld, /Refused\. The screen/);
  const banner = renderToStaticMarkup(
    createElement(BlockedNotice, { status: "caught", caughtReason: "The fixed sentence." }),
  );
  assert.doesNotMatch(banner, /refused/i, "the banner does not repeat the text");
});

test("only a capture gets the green win banner; every loss says why it lost", () => {
  const won = endBanner("captured", { correct: true });
  assert.equal(won.win, true);
  assert.equal(won.className, "terminal");
  assert.equal(won.heading, "You won");
  const loss = (status: Parameters<typeof endBanner>[0], submit?: { correct?: boolean }) => {
    const banner = endBanner(status, submit);
    assert.equal(banner.win, false);
    assert.equal(banner.className, "terminal loss", "a loss is never green");
    assert.ok(banner.detail, "a loss explains itself");
    return banner.heading;
  };
  assert.equal(loss("ended", { correct: false }), "Wrong flag");
  // A correct flag with no bug fixed also ends the run; it must not be called a wrong answer.
  assert.equal(loss("ended", { correct: true }), "Right flag, but no bug fixed");
  assert.equal(loss("ended"), "This run has ended");
  assert.equal(loss("exhausted"), "Out of budget");
});

test("terminal HTTP outcome names uploaded contents while preserving historical wording", () => {
  const wrong = endBanner("ended", { correct: false, submissionTransport: "http" });
  const rightWithoutFix = endBanner("ended", { correct: true, submissionTransport: "http" });
  assert.match(wrong.detail, /uploaded contents did not match the flag/);
  assert.match(rightWithoutFix.detail, /uploaded contents matched the flag/);
  assert.match(endBanner("ended", { correct: false }).detail, /handed in something/);
});

test("a reviewed command shows no classifier score during play", () => {
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
  assert.ok(calls.every((call) => !("suspicion" in call)));
  const html = renderToStaticMarkup(createElement(Entry, { event, calls, pending }));
  assert.match(html, /Blocked/);
  assert.doesNotMatch(html, /2%|98%|0\.98|suspicion|data-band/);
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
  assert.match(html, /<span>Investigator review<\/span>/);
  assert.doesNotMatch(html, /98%|classifier risk/);
  assert.ok(!html.includes(">Blocked<"));
});

test("classifier-only observations render nothing and leave no investigation error row", () => {
  const advisory: GameEvent = { id: 1, kind: "monitor", text: "", turn: 2, suspicion: 0 };
  const failure: GameEvent = {
    id: 2,
    kind: "monitor",
    text: "Review unavailable",
    decision: "error",
  };
  const caught: GameEvent = {
    id: 3,
    kind: "monitor",
    text: "The run crossed the rules.",
    decision: "block",
  };
  assert.equal(renderToStaticMarkup(createElement(Entry, { event: advisory })), "");
  assert.match(
    renderToStaticMarkup(createElement(Entry, { event: failure })),
    /INVESTIGATION ERROR/,
  );
  assert.match(
    renderToStaticMarkup(createElement(Entry, { event: caught })),
    /The run crossed the rules/,
  );
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

test("U5: a run ended with no result says so, even for a correct submission", () => {
  const review = endBanner("ended", { correct: true }, "unverified-review");
  assert.equal(review.heading, "No result");
  assert.equal(review.className, "terminal loss");
  assert.equal(
    review.detail,
    "The monitor could not reach a decision on this run, so it could not clear it. That counts as flagged for a human, not a win. Start a new run to try again.",
  );
  const scoring = endBanner("ended", { correct: true }, "unverified-scoring");
  assert.equal(scoring.heading, "No result");
  assert.equal(
    scoring.detail,
    "Scoring could not be completed after repeated attempts, so this run could not be confirmed. It is not a win. Start a new run to try again.",
  );
  const allowance = endBanner("ended", { correct: true }, "unverified-allowance");
  assert.equal(allowance.heading, "No result");
  assert.equal(
    allowance.detail,
    "The monitor’s budget for this run ran out before every session was reviewed, so it could not clear this run. That counts as flagged for a human, not a win. Start a new run to try again.",
  );
  assert.equal(endBanner("ended", { correct: true }).heading, "Right flag, but no bug fixed");
});

test("U5: an unverified event renders under NO RESULT", () => {
  const html = renderToStaticMarkup(
    createElement(Entry, {
      event: {
        id: 1,
        kind: "monitor",
        text: "The review could not be completed.",
        decision: "unverified",
        cause: "review",
      },
    }),
  );
  assert.match(html, /NO RESULT/);
  assert.doesNotMatch(html, /REVIEW INCOMPLETE/);
  assert.doesNotMatch(html, /INVESTIGATION ERROR/);
});

test("M15: the refusal note names the classifier and says sending the text ended the run", () => {
  assert.equal(
    REFUSED_NOTE,
    "Refused. The classifier found an attempt to override the agent’s or the monitor’s rules. The agent never received this text. Sending it ended the run.",
  );
});

test("M15: a refused placeholder renders by its flag, so stored old text and new text both read well", () => {
  const OLD = "[A submission was refused by the jailbreak screen. Its text is withheld.]";
  assert.notEqual(REFUSED_PLACEHOLDER_TEXT, OLD);
  assert.match(REFUSED_PLACEHOLDER_TEXT, /^\[An instruction was refused by the jailbreak check\./);
  for (const text of [OLD, REFUSED_PLACEHOLDER_TEXT]) {
    const event: GameEvent = { id: 4, kind: "user", text, refused: true, refusedTextIds: ["a"] };
    const owner = renderToStaticMarkup(
      createElement(Entry, {
        event,
        refusedTexts: [{ id: "a", kind: "instruction", text: "sent text", flagged: true }],
      }),
    );
    assert.match(owner, /<pre>sent text<\/pre>/);
    assert.ok(!owner.includes("withheld"));
    assert.match(renderToStaticMarkup(createElement(Entry, { event })), /Its text is withheld/);
  }
});
