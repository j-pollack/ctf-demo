import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Home from "../app/page";

test("public landing renders without database access and does not offer sign-in while auth loads", () => {
  const html = renderToStaticMarkup(createElement(Home));
  assert.match(html, /Plant the flag/);
  assert.match(html, /href="\/play"/);
  assert.match(html, /disabled="" aria-busy="true">Loading…/);
  assert.doesNotMatch(html, /href="\/play\?signin=1"/);
  assert.match(html, /\/tmp\/flag\.txt/);
  assert.match(html, /blocked command is a clue/);
  assert.match(html, /\$0\.60 per run/);
  assert.doesNotMatch(html, /Tripwire|tripwire|<textarea/);
});
