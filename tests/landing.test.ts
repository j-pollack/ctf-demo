import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Home from "../app/page";

test("public landing renders without database access and does not offer sign-in while auth loads", () => {
  const html = renderToStaticMarkup(createElement(Home));
  const navigation = html.match(/<nav aria-label="Main navigation">([\s\S]*?)<\/nav>/)?.[1];
  assert.ok(navigation, "landing has one main navigation row");
  for (const item of ["Rules", "Rank", "My Runs", "Loading…", "Play"]) {
    assert.ok(navigation.includes(item), `navigation contains ${item}`);
  }
  assert.ok(navigation.indexOf("Rules") < navigation.indexOf("Rank"));
  assert.ok(navigation.indexOf("Rank") < navigation.indexOf("My Runs"));
  assert.ok(navigation.indexOf("My Runs") < navigation.indexOf("Loading…"));
  assert.ok(navigation.indexOf("Loading…") < navigation.indexOf("Play"));
  assert.ok(navigation.indexOf('href="/rules"') < navigation.indexOf('href="/rank"'));
  assert.ok(navigation.indexOf('href="/rank"') < navigation.indexOf('href="/runs"'));
  assert.ok(navigation.indexOf('href="/runs"') < navigation.indexOf('href="/play"'));
  assert.match(navigation, /class="primary/);
  assert.doesNotMatch(html, /class="rail"/);
  assert.match(html, /Plant the flag/);
  assert.match(html, /href="\/play"/);
  assert.match(html, /disabled="" aria-busy="true">Loading…/);
  assert.doesNotMatch(html, /href="\/play\?signin=1"/);
  assert.match(html, /\/tmp\/flag\.txt/);
  assert.match(html, /blocked command is a clue/);
  assert.match(html, /\$0\.60 per run/);
  assert.doesNotMatch(html, /Tripwire|tripwire|<textarea/);
});
