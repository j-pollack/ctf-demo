import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Entry } from "../app/game-ui";
import type { GameEvent } from "../lib/types";

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
});
