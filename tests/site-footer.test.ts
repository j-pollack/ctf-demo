import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ContactPage from "../app/contact/page";
import { LeaderboardPanel, RulesPanel } from "../app/game-ui";
import LandingContent from "../app/landing-content";
import { DEFAULT_LIMITS, playerLimits } from "../lib/limits";

const rules = { monitorIsolation: false, bugFixRequired: true, jailbreakCatch: false };
const limits = playerLimits(DEFAULT_LIMITS);
const LINKS = ["https://jonathanpollack.net", "https://github.com/j-pollack/ctf-demo", "/contact"];

const pages = {
  "/": () => createElement(LandingContent, { submissionUrl: null, rules, limits }),
  "/contact": () => createElement(ContactPage),
  "/rules": () => createElement(RulesPanel, { rules, limits }),
  "/rank": () =>
    createElement(LeaderboardPanel, {
      scores: [],
      models: [],
      boardAgent: "",
      onAgentChange: () => {},
    }),
};

test("F13: the footer links to the author, the source and the contact page", () => {
  for (const [path, page] of Object.entries(pages)) {
    const html = renderToStaticMarkup(page());
    const footer = html.match(/<footer[^>]*>([\s\S]*?)<\/footer>/)?.[1];
    assert.ok(footer, `${path} renders a footer`);
    for (const href of LINKS) assert.ok(footer.includes(`href="${href}"`), `${path} links ${href}`);
    assert.equal(html.split("<footer").length, 2, `${path} renders one footer`);
  }
});

test("the rules say how to report a wrong catch and ask for feedback", () => {
  const html = renderToStaticMarkup(pages["/rules"]());
  const body = html.replace(/<footer[\s\S]*<\/footer>/, "");
  assert.match(
    body,
    /If you think the monitor got a run wrong, or something is broken, press <strong>Report<\/strong> in that run\. The run goes with your report, and we read every one\./,
  );
  assert.match(
    body,
    /We want to hear what you think of the game\. <a class="link" href="\/contact">Tell us<\/a>\./,
  );
});

const SHA = "0123456789abcdef0123456789abcdef01234567";

function footerWith(sha: string | undefined) {
  const saved = process.env.BUILD_COMMIT_SHA;
  if (sha === undefined) delete process.env.BUILD_COMMIT_SHA;
  else process.env.BUILD_COMMIT_SHA = sha;
  try {
    return renderToStaticMarkup(pages["/contact"]()).match(/<footer[^>]*>([\s\S]*?)<\/footer>/)![1];
  } finally {
    if (saved === undefined) delete process.env.BUILD_COMMIT_SHA;
    else process.env.BUILD_COMMIT_SHA = saved;
  }
}

test("footer links that leave the site open a new tab and say so; the contact link does not", () => {
  for (const [sha, count] of [
    [undefined, 3],
    [SHA, 4],
  ] as const) {
    const links = [...footerWith(sha).matchAll(/<a [^>]*href="([^"]+)"[^>]*>[\s\S]*?<\/a>/g)];
    assert.equal(links.length, count, String(sha));
    for (const [html, href] of links) {
      const external = href.startsWith("https://");
      assert.equal(/target="_blank"/.test(html), external, href);
      assert.equal(/rel="noopener noreferrer"/.test(html), external, href);
      assert.equal(/<span aria-hidden="true"> ↗<\/span>/.test(html), external, href);
      assert.equal(
        /<span class="visually-hidden"> \(opens in a new tab\)<\/span>/.test(html),
        external,
        href,
      );
    }
  }
});

test("the footer shows the first 7 characters of the build's commit id, linked to the commit", () => {
  const footer = footerWith(SHA);
  const link = footer.match(/<span data-testid="site-version">(<a [\s\S]*?<\/a>)<\/span>/)?.[1];
  assert.ok(link, "version link present");
  assert.match(link, new RegExp(`href="https://github.com/j-pollack/ctf-demo/commit/${SHA}"`));
  assert.match(link, /target="_blank"/);
  assert.match(
    link,
    /^<a [^>]*><span class="visually-hidden">Version <\/span>0123456<span aria-hidden="true"> ↗<\/span>/,
  );
});

test("the footer has no version element without a well-formed commit id", () => {
  const plain = footerWith(undefined);
  assert.ok(!plain.includes("site-version"));
  for (const bad of [
    SHA.slice(1),
    SHA.toUpperCase(),
    `${SHA.slice(0, 30)}"/><b>x</b>`,
    "",
    `${SHA}0`,
  ]) {
    assert.equal(footerWith(bad), plain, JSON.stringify(bad));
  }
});
