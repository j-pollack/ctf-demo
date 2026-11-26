import assert from "node:assert/strict";
import { test } from "node:test";
import { contactSender, parseFeedback } from "../lib/feedback";
import { GameError } from "../lib/policy";

const GAME = "11111111-2222-4333-8444-555555555555";
const SESSION = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const contact = { kind: "contact", name: " Ada ", email: " ada@example.com ", message: " Hi\n " };

const refused = (data: Record<string, unknown>) =>
  assert.throws(
    () => parseFeedback(data),
    (error) => error instanceof GameError && error.status === 400,
    JSON.stringify(data).slice(0, 80),
  );

test("F3: a contact message is trimmed", () => {
  assert.deepEqual(parseFeedback(contact), {
    kind: "contact",
    name: "Ada",
    email: "ada@example.com",
    message: "Hi",
  });
});

test("F3: a run report carries its run and an optional session", () => {
  assert.deepEqual(parseFeedback({ kind: "bug", gameId: GAME, message: "Broke" }), {
    kind: "bug",
    gameId: GAME,
    sessionId: null,
    message: "Broke",
  });
  for (const kind of ["monitor", "other"])
    assert.deepEqual(parseFeedback({ kind, gameId: GAME, sessionId: SESSION, message: "x" }), {
      kind,
      gameId: GAME,
      sessionId: SESSION,
      message: "x",
    });
});

test("F3: bad contact bodies are refused with 400", () => {
  refused({ ...contact, kind: undefined });
  refused({ ...contact, kind: "spam" });
  refused({ ...contact, name: undefined });
  refused({ ...contact, name: "   " });
  refused({ ...contact, name: "a".repeat(101) });
  refused({ ...contact, name: 5 });
  for (const email of ["", "ada", "ada@example", "a da@example.com", "@example.com", "a@b@c.com"])
    refused({ ...contact, email });
  refused({ ...contact, email: `${"a".repeat(250)}@b.co` });
  refused({ ...contact, message: undefined });
  refused({ ...contact, message: "a\u0000b" });
  refused({ ...contact, message: "  " });
  refused({ ...contact, message: "a".repeat(5001) });
  refused({ ...contact, gameId: GAME });
  refused({ ...contact, sessionId: SESSION });
});

test("F3: limits are inclusive and measured after trimming", () => {
  parseFeedback({ ...contact, name: ` ${"a".repeat(100)} `, message: "a".repeat(5000) });
  const email = `${"a".repeat(249)}@b.co`;
  assert.equal(email.length, 254);
  parseFeedback({ ...contact, email });
});

test("F3: bad report bodies are refused with 400", () => {
  refused({ kind: "bug", message: "x" });
  refused({ kind: "bug", gameId: "nope", message: "x" });
  refused({ kind: "bug", gameId: GAME, sessionId: "nope", message: "x" });
  refused({ kind: "bug", gameId: GAME, message: "" });
  refused({ kind: "bug", gameId: GAME, message: "a".repeat(5001) });
  refused({ kind: "bug", gameId: 5, message: "x" });
});

test("F8, F11: a contact sender is a keyed hash of the address and groups IPv6 by prefix", () => {
  const sender = (forwarded?: string) =>
    contactSender(new Headers(forwarded ? { "x-forwarded-for": forwarded } : {}), "secret");
  const a = sender("203.0.113.9, 10.0.0.1");
  assert.match(a, /^ip:[0-9a-f]{64}$/);
  assert.ok(!a.includes("203.0.113.9"));
  assert.equal(a, sender("203.0.113.9"));
  assert.notEqual(a, sender("203.0.113.10"));
  assert.notEqual(a, contactSender(new Headers({ "x-forwarded-for": "203.0.113.9" }), "other"));
  assert.equal(sender("2001:db8:1:2:aaaa::1"), sender("2001:db8:1:2:bbbb::2"));
  assert.notEqual(sender("2001:db8:1:2:aaaa::1"), sender("2001:db8:1:3:aaaa::1"));
  assert.equal(sender(), "ip:unknown");
  assert.notEqual(sender(), a);
});
