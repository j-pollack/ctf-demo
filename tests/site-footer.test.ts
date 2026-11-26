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
