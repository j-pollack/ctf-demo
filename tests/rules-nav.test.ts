import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { currentSection, RulesNav } from "../app/rules-nav";

const line = 200;

test("the first section is current until a later heading passes the reading line", () => {
  assert.equal(currentSection([80, 900, 1800], line, false), 0);
  assert.equal(currentSection([400, 900, 1800], line, false), 0, "above the first heading");
});

test("the last heading above the reading line is current", () => {
  assert.equal(currentSection([-900, 150, 700], line, false), 1);
  assert.equal(currentSection([-1800, -900, 200], line, false), 2, "a heading on the line counts");
});

test("at the end of the page the last section is current even if its heading never reaches the line", () => {
  assert.equal(currentSection([-1800, -900, 500], line, true), 2);
});

test("the nav renders one link per section with no current link before it mounts", () => {
  const html = renderToStaticMarkup(
    createElement(RulesNav, {
      sections: [
        ["how-to-win", "How to win"],
        ["glossary", "Glossary"],
      ],
    }),
  );
  assert.match(html, /<nav class="rules-nav" aria-labelledby="rules-nav-label">/);
  assert.deepEqual(
    [...html.matchAll(/href="#([^"]+)"/g)].map((match) => match[1]),
    ["how-to-win", "glossary"],
  );
  assert.doesNotMatch(html, /aria-current/);
});
