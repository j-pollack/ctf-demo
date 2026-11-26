import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ContactPage from "../app/contact/page";
import { LeaderboardPanel, RulesPanel } from "../app/game-ui";
import LandingContent from "../app/landing-content";

const rules = { monitorIsolation: false, bugFixRequired: true, jailbreakCatch: false };
const LINKS = ["https://jonathanpollack.net", "https://github.com/j-pollack/ctf-demo", "/contact"];

const pages = {
  "/": () => createElement(LandingContent, { submissionUrl: null, rules }),
  "/contact": () => createElement(ContactPage),
  "/rules": () => createElement(RulesPanel, { rules }),
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

test("footer links that leave the site open a new tab and say so; the contact link does not", () => {
  const footer = renderToStaticMarkup(pages["/contact"]()).match(
    /<footer[^>]*>([\s\S]*?)<\/footer>/,
  )![1];
  const links = [...footer.matchAll(/<a [^>]*href="([^"]+)"[^>]*>[\s\S]*?<\/a>/g)];
  assert.equal(links.length, 3);
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
});
