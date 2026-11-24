import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AccountPanel,
  EmailFields,
  type AccountPanelProps,
  type EmailFieldsProps,
} from "../app/account/account-panel";

const render = (extra: Partial<AccountPanelProps> = {}) =>
  renderToStaticMarkup(
    createElement(AccountPanel, {
      email: "me@example.com",
      displayName: "Night_Owl-7",
      next: null,
      notice: null,
      ...extra,
    }),
  );

test("the name field is labelled, says it is for the leaderboard, and ties its hint and error to it", () => {
  const html = render();
  assert.match(html, /<label for="display-name">Display name<\/label>/);
  assert.match(
    html,
    /<p id="display-name-hint" class="hint">Shown on the leaderboard\. 3 to 24 letters, digits, hyphens or underscores\.<\/p>/,
  );
  const input = html.match(/<input id="display-name"[^>]*>/)?.[0] ?? "";
  assert.match(input, /aria-describedby="display-name-hint display-name-error"/);
  assert.match(input, /pattern="\[A-Za-z0-9_\\-\]\{3,24\}"/);
  assert.match(input, /required=""/);
  assert.match(input, /minLength="3" maxLength="24"/);
  assert.match(input, /value="Night_Owl-7"/);
  assert.match(input, /aria-invalid="false"/);
  assert.match(html, /<p id="display-name-error" role="alert" class="field-error"><\/p>/);
  assert.match(html, /<button class="primary">Save name<\/button>/);
  // Live regions exist, empty, before they announce anything.
  assert.match(
    html,
    /<button class="primary">Save name<\/button><p role="status" class="saved"><\/p><\/form>/,
  );
  assert.match(
    html,
    /<button>Send confirmation link<\/button><p role="status" class="saved"><\/p><\/form>/,
  );
});

test("a nameless account is told a name finishes setup and is needed to play", () => {
  const html = render({ displayName: null, next: "/play" });
  assert.match(
    html,
    /<p role="status" class="notice">Choose a display name to finish setting up your account\. You need one to start a run\.<\/p>/,
  );
  assert.match(html, /<input id="display-name"[^>]*autofocus=""[^>]*value=""/i);
  assert.match(html, /<button class="primary">Save name and play<\/button>/);
  assert.doesNotMatch(render(), /finish setting up/);
});

test("the email form shows the current address and explains both links", () => {
  const html = render();
  assert.match(html, /Signed in as <strong>me@example\.com<\/strong>\./);
  assert.match(html, /<label for="new-email">New email address<\/label>/);
  const input = html.match(/<input id="new-email"[^>]*>/)?.[0] ?? "";
  assert.match(input, /type="email"/);
  assert.match(input, /aria-describedby="new-email-hint new-email-error"/);
  assert.match(
    html,
    /<p id="new-email-hint" class="hint">We send a link to your current address first, then one to the new address\. Your email is never shown on the leaderboard\.<\/p>/,
  );
  assert.match(html, /<button>Send confirmation link<\/button>/);
});

test("a finished or failed email link is reported at the top", () => {
  assert.match(
    render({ notice: "changed" }),
    /<p role="status" class="notice">Your email is now me@example\.com\.<\/p>/,
  );
  assert.match(
    render({ notice: "confirmed" }),
    /<p role="status" class="notice">Confirmed\. Open the link we sent to your new address to finish the change\.<\/p>/,
  );
  assert.match(
    render({ notice: "link-error" }),
    /<p role="alert" class="notice error">That link has expired or was already used\. Ask for a new one below\.<\/p>/,
  );
});

const emailFields = (extra: Partial<EmailFieldsProps>) =>
  renderToStaticMarkup(
    createElement(EmailFields, {
      email: "me@example.com",
      value: "",
      sentTo: "",
      busy: false,
      error: "",
      onChange: () => {},
      onSubmit: () => {},
      ...extra,
    }),
  );

test("after a link is sent the address is cleared and the same address cannot be sent again", () => {
  const sent = emailFields({ sentTo: "moved@example.com" });
  assert.match(sent, /<input id="new-email"[^>]*value=""/);
  assert.match(
    sent,
    /<p role="status" class="saved">Check me@example\.com and open the link there\. We then send a link to moved@example\.com to finish the change\.<\/p>/,
  );
  assert.match(sent, /<button>Send confirmation link<\/button>/, "a different address can go");
  assert.match(
    emailFields({ sentTo: "moved@example.com", value: "moved@example.com" }),
    /<button disabled="">Send confirmation link<\/button>/,
  );
  assert.match(emailFields({ busy: true }), /<button disabled="">Sending…<\/button>/);
});
