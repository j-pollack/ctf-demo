import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalEmail, signInEmailError } from "../lib/email";

test("Resend failures map to actionable messages and log the reason without secrets", (t) => {
  const logs: string[] = [];
  t.mock.method(console, "error", (line: string) => logs.push(line));
  const message = (error: Parameters<typeof signInEmailError>[0]) =>
    signInEmailError(error).message;
  const unavailable = /temporarily unavailable/;

  // The production incident: a send-only key scoped to another domain, returned without a name.
  assert.match(
    message({
      statusCode: 403,
      message: "This API key is not authorized to send emails from ctf.jonathanpollack.net",
    }),
    unavailable,
  );
  assert.equal(signInEmailError({ statusCode: 403 }).status, "SERVICE_UNAVAILABLE");
  assert.equal(signInEmailError({ statusCode: 429 }).status, "TOO_MANY_REQUESTS");
  assert.equal(signInEmailError({}).status, "BAD_GATEWAY");
  assert.match(message({ name: "restricted_api_key", statusCode: 401 }), unavailable);
  assert.match(message({ name: "invalid_from_address", statusCode: 422 }), unavailable);
  assert.match(message({ name: "daily_quota_exceeded", statusCode: 429 }), unavailable);
  assert.match(message({ name: "rate_limit_exceeded", statusCode: 429 }), /Wait a minute/);
  assert.match(message({ statusCode: 429 }), /Wait a minute/);
  assert.match(message({ name: "internal_server_error", statusCode: 500 }), /Please try again/);
  assert.match(message({}), /Please try again/);

  const first = JSON.parse(logs[0]);
  assert.deepEqual(
    { event: first.event, statusCode: first.statusCode, errorName: first.errorName },
    { event: "auth.email.failed", statusCode: 403, errorName: null },
  );
  assert.match(first.error, /not authorized to send emails from ctf\.jonathanpollack\.net/);
  assert.equal(logs.length, 11);
  assert.ok(logs.some((line) => JSON.parse(line).errorName === "restricted_api_key"));
});

test("plus-addressed variants collapse to one canonical address", () => {
  assert.equal(canonicalEmail("jonathan+1@gnobel.com"), "jonathan@gnobel.com");
  assert.equal(canonicalEmail("Jonathan+a+b@Gnobel.com"), "jonathan@gnobel.com");
  assert.equal(canonicalEmail(" jonathan@gnobel.com "), "jonathan@gnobel.com");
  // Gmail ignores dots and treats googlemail.com as the same mailbox.
  assert.equal(canonicalEmail("j.o.n.athan+1@gmail.com"), "jonathan@gmail.com");
  assert.equal(canonicalEmail("Jon.Athan@GoogleMail.com"), "jonathan@gmail.com");
  // Elsewhere a dot can separate two different people's mailboxes, so it stays.
  assert.equal(canonicalEmail("first.last@gnobel.com"), "first.last@gnobel.com");
  // Nothing left to deliver to: the result stays invalid so sign-in validation rejects it.
  assert.equal(canonicalEmail("+1@gnobel.com"), "@gnobel.com");
  assert.equal(canonicalEmail("not-an-email"), "not-an-email");
});
