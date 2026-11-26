import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SignInPanel, type SignInPanelProps } from "../app/sign-in-panel";

const render = (extra: Partial<SignInPanelProps> = {}) =>
  renderToStaticMarkup(
    createElement(SignInPanel, {
      email: "",
      sent: false,
      busy: false,
      error: "",
      onEmailChange: () => {},
      onSubmit: () => {},
      ...extra,
    }),
  );

test("the sign-in page has a heading, a labelled email field and a submit control", () => {
  const html = render({ email: "me@example.com" });
  assert.match(html, /^<main class="info sign-in"><h2>Sign in<\/h2>/);
  assert.match(html, /<label for="email">Email address<\/label>/);
  assert.match(
    html,
    /<input id="email" type="email" autoComplete="email" required=""[^>]*value="me@example.com"/,
  );
  assert.match(
    html,
    /<button class="primary" data-testid="signin-submit">Email me a link<\/button>/,
  );
  assert.doesNotMatch(html, /eyebrow|EMAIL ADDRESS|ACCOUNT/);
  assert.match(
    render({ busy: true }),
    /<button class="primary" disabled="" data-testid="signin-submit">Sending…<\/button>/,
  );
});

test("the page subtitle explains the link in two plain sentences, above the form", () => {
  const html = render();
  assert.match(
    html,
    /<h2>Sign in<\/h2><p class="lede">Enter your email and we’ll send you a sign-in link\. There’s no password\.<\/p><form/,
  );
  assert.doesNotMatch(html, /Sign in to play|Click it and you’re in/);
});

test("after a send the page says to check email and shows no form", () => {
  const html = render({ sent: true });
  assert.match(
    html,
    /<p role="status" data-testid="signin-sent">Check your email for a sign-in link\. It expires in five minutes\.<\/p>/,
  );
  assert.doesNotMatch(html, /<form|<input/);
  assert.doesNotMatch(html, /class="lede"/, "the subtitle goes with the form");
});

test("an error shows in the page's alert", () => {
  assert.match(
    render({ error: "Could not send your link." }),
    /<div role="alert" class="error">Could not send your link\.<\/div>/,
  );
  assert.doesNotMatch(render(), /role="alert"/);
});

test("the form tells a new player they choose a leaderboard name after the link", () => {
  assert.match(
    render(),
    /<p class="hint">New here\? After you open the link, you’ll choose a display name for the leaderboard\.<\/p>/,
  );
  assert.doesNotMatch(render({ sent: true }), /display name/);
});
