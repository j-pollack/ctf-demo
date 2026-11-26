import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ContactForm } from "../app/contact/contact-form";
import { EMAIL_MAX, MESSAGE_MAX, NAME_MAX } from "../lib/feedback-limits";

const html = renderToStaticMarkup(createElement(ContactForm));
const tag = (id: string) => html.match(new RegExp(`<(?:input|textarea)[^>]*id="${id}"[^>]*>`))?.[0];

test("F14: the contact form has labelled, required, length-limited fields", () => {
  for (const [id, label, max] of [
    ["contact-name", "Name", NAME_MAX],
    ["contact-email", "Email", EMAIL_MAX],
    ["contact-message", "Message", MESSAGE_MAX],
  ] as const) {
    assert.match(html, new RegExp(`<label for="${id}">${label}</label>`));
    const field = tag(id);
    assert.ok(field, id);
    assert.match(field, /\srequired=""/);
    assert.match(field, new RegExp(`maxLength="${max}"`));
  }
  assert.match(tag("contact-email")!, /type="email"/);
  assert.match(tag("contact-email")!, /autoComplete="email"/);
  assert.match(tag("contact-name")!, /autoComplete="name"/);
  assert.match(html, /<button[^>]*>Send<\/button>/);
  // A disabled button drops keyboard focus, so a busy send is marked with aria-disabled only.
  assert.match(
    html,
    /<button class="primary" aria-disabled="false" data-testid="contact-submit">Send<\/button>/,
  );
});

test("F14: the live regions are present and empty before anything is announced", () => {
  assert.match(html, /<p [^>]*role="alert"[^>]*><\/p>/);
  assert.match(html, /<p [^>]*role="status"[^>]*><\/p>/);
  assert.match(html, /We keep your name, email and message so we can reply\./);
});
