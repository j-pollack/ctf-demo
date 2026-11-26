import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SaveButton, saveButtonState } from "../app/admin/save-button";

test("an idle Save button submits its form and is not busy", () => {
  const html = renderToStaticMarkup(createElement(SaveButton));
  assert.match(html, /<button[^>]*type="submit"[^>]*>Save<\/button>/);
  assert.doesNotMatch(html, /disabled=""/);
  assert.match(html, /aria-busy="false"/);
});

test("a pending Save button says so and cannot be pressed twice", () => {
  assert.deepEqual(saveButtonState(false), { label: "Save", disabled: false });
  assert.deepEqual(saveButtonState(true), { label: "Saving…", disabled: true });
});
