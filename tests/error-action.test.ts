import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ErrorAction } from "../app/error-action";
import { NAME_REQUIRED } from "../lib/display-name-rule";

test("the run start refusal for a missing name links to the account page, back to play", () => {
  assert.equal(
    renderToStaticMarkup(createElement(ErrorAction, { message: NAME_REQUIRED })),
    '<a class="link" href="/account?next=%2Fplay">Choose a display name</a>',
  );
  assert.equal(renderToStaticMarkup(createElement(ErrorAction, { message: "Other." })), "");
});
