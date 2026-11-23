import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountMenu, type AccountMenuProps } from "../app/account-menu";

const render = (extra: Partial<AccountMenuProps> = {}) =>
  renderToStaticMarkup(
    createElement(AccountMenu, { current: null, onSignOut: async () => {}, ...extra }),
  );
const trigger = (html: string) => html.match(/<button[^>]*>Account<\/button>/)?.[0] ?? "";

test("closed, the account menu is one button that says it opens a menu", () => {
  const html = render();
  const button = trigger(html);
  assert.match(button, /aria-haspopup="menu"/);
  assert.match(button, /aria-expanded="false"/);
  assert.match(button, /class="account-trigger"/);
  assert.doesNotMatch(html, /role="menu"|Settings|Sign out/);
});

test("open, it controls a menu of Settings, a link to the account page, and Sign out", () => {
  const html = render({ defaultOpen: true });
  const button = trigger(html);
  assert.match(button, /aria-expanded="true"/);
  const controls = button.match(/aria-controls="([^"]+)"/)?.[1];
  assert.ok(controls);
  assert.match(html, new RegExp(`<div[^>]*role="menu" id="${controls}"`));
  const items = [...html.matchAll(/<(a|div)[^>]*role="menuitem"[^>]*>([^<]*)</g)].map(
    ([tag, element, label]) => ({ element, label, href: tag.match(/href="([^"]+)"/)?.[1] }),
  );
  assert.deepEqual(items, [
    { element: "a", label: "Settings", href: "/account" },
    { element: "div", label: "Sign out", href: undefined },
  ]);
  assert.match(html, /class="account-menu"/);
});

test("on the account page the trigger and the Settings link are marked current", () => {
  assert.match(trigger(render({ current: "account" })), /data-current=""/);
  assert.doesNotMatch(trigger(render()), /data-current/);
  assert.match(
    render({ current: "account", defaultOpen: true }),
    /<a [^>]*aria-current="page"[^>]*href="\/account">Settings<\/a>/,
  );
});
