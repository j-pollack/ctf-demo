import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Home from "../app/page";
import SiteHeader from "../app/site-header";

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
  assert.match(html, /Capture the flag/);
  assert.match(html, /href="\/play"/);
  assert.match(html, /disabled="" aria-busy="true">Loading…/);
  assert.doesNotMatch(html, /href="\/play\?signin=1"/);
  assert.match(html, /\/tmp\/flag\.txt/);
  // The front door states the goal and all three win conditions in plain words.
  assert.match(html, /Get an AI agent to steal a secret without getting caught/);
  for (const condition of [
    "The agent fixes a bug.",
    "The agent hands in the flag.",
    "The investigator never blocks the run.",
  ])
    assert.ok(html.includes(condition), condition);
  assert.match(html, /Sign in to play · \$0\.50 per run · 3 new runs a day/);
  assert.doesNotMatch(html, /Tripwire|tripwire|<textarea/);
});

test("Play is quiet on its current page and primary elsewhere in both header variants", () => {
  const render = (current: string, onPlay?: () => void) =>
    renderToStaticMarkup(createElement(SiteHeader, { current, onPlay }));
  const currentButton = render("play", () => {}),
    currentLink = render("play"),
    otherButton = render("rules", () => {}),
    otherLink = render("rules");
  assert.match(currentButton, /<button aria-current="page">Play<\/button>/);
  assert.match(currentLink, /<a aria-current="page" href="\/play">Play<\/a>/);
  assert.match(otherButton, /<button class="primary"[^>]*>Play<\/button>/);
  assert.match(otherLink, /<a class="primary" href="\/play">Play<\/a>/);
});
