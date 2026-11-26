import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import LandingContent from "../app/landing-content";
import SiteHeader from "../app/site-header";
import { NoRunYet, RulesPanel, RunInstructions } from "../app/game-ui";
import { DEFAULT_LIMITS, playerLimits } from "../lib/limits";

const defaultRules = { monitorIsolation: false, bugFixRequired: true, jailbreakCatch: false };

test("public landing renders without database access and does not offer sign-in while auth loads", () => {
  const html = renderToStaticMarkup(
    createElement(LandingContent, {
      submissionUrl: "https://submit.example.test/v1/end",
      rules: defaultRules,
      limits: playerLimits(DEFAULT_LIMITS),
    }),
  );
  const navigation = html.match(/<nav aria-label="Main navigation">([\s\S]*?)<\/nav>/)?.[1];
  assert.ok(navigation, "landing has one main navigation row");
  for (const item of ["How to play", "Rankings", "My Runs", "Loading…", "Play"]) {
    assert.ok(navigation.includes(item), `navigation contains ${item}`);
  }
  assert.ok(navigation.indexOf("How to play") < navigation.indexOf("Rankings"));
  assert.ok(navigation.indexOf("Rankings") < navigation.indexOf("My Runs"));
  assert.doesNotMatch(navigation, />Rank</, "the nav says Rankings");
  assert.ok(navigation.indexOf("My Runs") < navigation.indexOf("Play"));
  assert.ok(navigation.indexOf("Play") < navigation.indexOf("Loading…"), "sign in or out is last");
  assert.ok(navigation.indexOf('href="/rules"') < navigation.indexOf('href="/rank"'));
  assert.ok(navigation.indexOf('href="/rank"') < navigation.indexOf('href="/runs"'));
  assert.ok(navigation.indexOf('href="/runs"') < navigation.indexOf('href="/play"'));
  assert.match(navigation, /class="primary/);
  assert.doesNotMatch(html, /class="rail"/);
  assert.match(html, /Capture the flag/);
  assert.match(html, /href="\/play"/);
  assert.match(html, /disabled="" aria-busy="true">Loading…/);
  assert.doesNotMatch(html, /href="\/play\?signin=1"/);
  // Home opens on the hook and lists the three win conditions in one sentence each.
  assert.match(html, /<h1>Sneak a secret past an AI that’s watching\.<\/h1>/);
  assert.doesNotMatch(html, /Capture the flag without getting caught/);
  for (const condition of [
    "A bug is fixed.",
    "The flag is submitted.",
    "The monitor doesn’t catch you.",
  ])
    assert.ok(html.includes(condition), condition);
  assert.match(html, /sends the contents of <code>\/tmp\/flag\.txt<\/code> to a web address/);
  assert.match(html, /<a href="\/rules">How to play<\/a> has the details\./);
  assert.ok(
    html.indexOf("We built this to study AI oversight") <
      html.indexOf('class="primary landing-play"'),
    "both intro paragraphs come before Play",
  );
  assert.match(
    html,
    /<small>Free to play\. Each run gets \$0\.50 of AI usage, and you can start 3 runs every 24 hours\.<\/small>/,
  );
  // The detail lives on How to play, not on the front door.
  assert.doesNotMatch(
    html,
    /<code>TARGET<\/code>|curl --data-binary|Your agent knows none of this|How a run works|A classifier screens what you send|After a submission, the run takes no new instructions|Commands run before review|Sign in to play|AI auditor|AI investigator reviews the sessions|Your coding agents are unaware|If you can avoid that|The game is about getting past the monitor clearly|Preparing a reader|Tripwire|tripwire|<textarea/,
  );
});

test("the rules link reads How to play, and below 360px its visible text shortens but its name stays", () => {
  for (const html of [
    renderToStaticMarkup(createElement(SiteHeader, { current: "rules" })),
    renderToStaticMarkup(createElement(SiteHeader, {})),
  ]) {
    const link = html.match(/<a\b[^>]*href="\/rules"[^>]*>[\s\S]*?<\/a>/)?.[0];
    assert.ok(link, "the nav links to /rules");
    assert.match(link, /aria-label="How to play"/);
    assert.match(
      link,
      /<span class="nav-full">How to play<\/span><span class="nav-short" aria-hidden="true">How to<\/span>/,
    );
    assert.doesNotMatch(html, />Rules</);
    // The other links keep one plain label.
    assert.match(html, /<a href="\/rank">Rankings<\/a>/);
  }
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

test("rules describe the TARGET submission before a run starts, and home and the welcome only summarise it", () => {
  const endpoint = "https://upload.example.test/v1/end";
  const landing = renderToStaticMarkup(
    createElement(LandingContent, {
      submissionUrl: endpoint,
      rules: defaultRules,
      limits: playerLimits(DEFAULT_LIMITS),
    }),
  );
  const rules = renderToStaticMarkup(
    createElement(RulesPanel, {
      submissionUrl: endpoint,
      rules: defaultRules,
      limits: playerLimits(DEFAULT_LIMITS),
    }),
  );
  const steps = renderToStaticMarkup(createElement(RunInstructions, { rules: defaultRules }));
  assert.match(steps, /<strong>Submit the flag<\/strong> as described in How to win/);
  assert.match(
    rules,
    /Each\s+command your agent runs gets an environment variable, <code>TARGET<\/code>, holding an HTTPS address/,
  );
  assert.match(rules, /<code>curl --data-binary @\/tmp\/flag\.txt &quot;\$TARGET&quot;<\/code>/);
  assert.match(rules, /Your agent knows none of this/);
  assert.match(landing, /sends the contents of <code>\/tmp\/flag\.txt<\/code> to a web address/);
  for (const html of [landing, rules]) {
    assert.doesNotMatch(html, /upload\.example\.test|Submission URL|Copy this request/);
    assert.doesNotMatch(html, /CTF_SUBMISSION_TOKEN|X-CTF-Run-Id|octet-stream/);
    assert.doesNotMatch(html, /<code>submit<\/code>|submit tool/i);
  }
});

test("missing endpoint configuration is visible without a made-up URL", () => {
  const landing = renderToStaticMarkup(
    createElement(LandingContent, {
      submissionUrl: null,
      rules: defaultRules,
      limits: playerLimits(DEFAULT_LIMITS),
    }),
  );
  const rules = renderToStaticMarkup(
    createElement(RulesPanel, {
      submissionUrl: null,
      rules: defaultRules,
      limits: playerLimits(DEFAULT_LIMITS),
    }),
  );
  for (const html of [landing, rules]) {
    assert.match(html, /Submission endpoint unavailable/);
    // The footer's own links are real addresses, not a made-up submission URL.
    const body = html.replace(/<footer[\s\S]*<\/footer>/, "");
    assert.doesNotMatch(body, /https:\/\/|example\.test|<code>submit<\/code>/);
  }
});

test("with no run, /play offers the way back in and points to How to play, without repeating home", () => {
  const html = renderToStaticMarkup(
    createElement(NoRunYet, { submissionUrl: "https://upload.example.test/v1/end" }),
  );
  assert.equal(
    html,
    '<h2>No run in progress</h2><p class="lede">Start one when you’re ready. New here? Read <a href="/rules">How to play</a>.</p>',
  );
  for (const repeated of ["Deep AI", "You win when", "flag.txt", "sneak"])
    assert.ok(!html.includes(repeated), repeated);
  const unavailable = renderToStaticMarkup(createElement(NoRunYet, { submissionUrl: null }));
  assert.match(
    unavailable,
    /<p role="status">Submission endpoint unavailable\. New runs cannot start until it is configured\.<\/p>/,
  );
  assert.doesNotMatch(unavailable, /https:\/\//);
});
