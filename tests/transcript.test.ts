import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Entry, ForkPreview, groupTurns, refreshedGame } from "../app/game-ui";
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
  assert.match(agent, /aria-label="Fork from response"/);
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

test("fork preview shows the full visible prefix through selection only", () => {
  const selectedText = `${"long text ".repeat(60)}\n\n<script>safe</script>`;
  const events: GameEvent[] = [
    { id: 1, kind: "user", text: "Earlier instruction" },
    { id: 2, kind: "agent", text: "Earlier answer", turn: 1, model: "m" },
    { id: 3, kind: "monitor", text: "hidden allow", decision: "allow" },
    { id: 4, kind: "tool", text: "Earlier tool output" },
    { id: 5, kind: "user", text: "Selected instruction" },
    { id: 6, kind: "agent", text: selectedText, turn: 2, model: "m" },
    { id: 7, kind: "tool", text: "Later tool output" },
    { id: 8, kind: "agent", text: "Later answer", turn: 3, model: "m" },
  ];
  const html = renderToStaticMarkup(createElement(ForkPreview, { events, selectedId: 6 }));
  assert.match(html, /Earlier instruction/);
  assert.match(html, /Earlier answer/);
  assert.match(html, /Earlier tool output/);
  assert.ok(html.includes(selectedText.slice(500, 560)));
  assert.match(
    html,
    /role="region" aria-label="Visible transcript history through selected response" tabindex="0"/,
  );
  assert.doesNotMatch(html, /Later tool output|Later answer|hidden allow|Copy|Fork/);
  assert.match(html, /&lt;script&gt;safe&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
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
      groupTurns(events).map(({ event, calls, remainder }) =>
        createElement(Entry, { key: event.id, event, calls, remainder }),
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

test("copy and fork sit in the agent header as compact labelled icon buttons", () => {
  const html = renderToStaticMarkup(
    createElement(Entry, { event: { id: 1, kind: "agent", text: "Hi", turn: 2, model: "m" } }),
  );
  const header = html.slice(html.indexOf("<header>"), html.indexOf("</header>"));
  assert.match(header, /<div class="entry-actions">/);
  assert.match(header, /aria-label="Copy response"/);
  assert.match(header, /aria-label="Fork from response"/);
  assert.doesNotMatch(html, /<\/article><div class="entry-actions">|entry-action-label/);
});

test("fork preview shows the selected turn's commands without their outputs", () => {
  const events: GameEvent[] = [
    { id: 1, kind: "agent", text: "Earlier", turn: 1, model: "m", command: "ls" },
    { id: 2, kind: "monitor", text: "", decision: "allow", command: "ls" },
    { id: 3, kind: "tool", text: "earlier output" },
    { id: 4, kind: "agent", text: "Selected", turn: 2, model: "m", command: "pwd" },
    { id: 5, kind: "monitor", text: "", decision: "allow", command: "pwd" },
    { id: 6, kind: "tool", text: "later output" },
  ];
  const html = renderToStaticMarkup(createElement(ForkPreview, { events, selectedId: 4 }));
  assert.match(html, /<pre>ls<\/pre>[^]*earlier output/);
  assert.match(html, /<pre>pwd<\/pre>/);
  assert.doesNotMatch(html, /later output|TOOL OUTPUT/);
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
