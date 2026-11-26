import assert from "node:assert/strict";
import { test } from "node:test";
import {
  notificationId,
  notificationSubject,
  replyBody,
  threadState,
} from "../lib/feedback-mail-text";

const GAME = "11111111-2222-4333-8444-555555555555";
const ROW = "0f8fad5b-d9cb-469f-a165-70867728950e";
const mail = (messageId: string | null, sent: boolean) => ({
  messageId,
  from: "x@example.com",
  receivedAt: new Date(),
  sent,
});

test("M5: control characters and line breaks never reach the subject", () => {
  const subject = notificationSubject({
    kind: "contact",
    name: "Ada\r\nBcc: evil@example.com\u0000\u2028\u202Ex",
    gameId: null,
  });
  assert.doesNotMatch(subject, /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
  assert.match(subject, /^\[CTF\] Contact from Ada {2}Bcc: evil@example\.com {3}x$/);
});

test("the report subject names the kind and the first eight characters of the run", () => {
  assert.equal(
    notificationSubject({ kind: "bug", name: null, gameId: GAME }),
    "[CTF] Report (bug) on run 11111111",
  );
});

test("the notification's Message-ID is derived from the row and fits Fastmail's limit", () => {
  const id = notificationId(ROW, "contact@ctf.example.test");
  assert.match(id, /^fb\.[A-Za-z0-9_-]{22}@ctf\.example\.test$/);
  assert.equal(
    id,
    notificationId(ROW, "contact@ctf.example.test"),
    "the same row gives the same id",
  );
  assert.notEqual(id, notificationId(GAME, "contact@ctf.example.test"));
  // Fastmail refuses a Message-ID longer than 64 characters: the header line may not pass 78.
  assert.ok(notificationId(ROW, `contact@${"d".repeat(34)}.net`).length <= 64);
});

test("M13: the state rule", () => {
  const note = mail(notificationId(ROW, "contact@ctf.example.test"), true);
  assert.equal(threadState([note], ROW), "waiting");
  assert.equal(threadState([note, mail("a", true)], ROW), "answered");
  assert.equal(threadState([note, mail("a", true), mail("b", false)], ROW), "waiting");
  assert.equal(threadState([], ROW), "waiting");
  assert.equal(
    threadState([mail(notificationId(ROW, "contact@moved.example.test"), true)], ROW),
    "waiting",
    "a notification sent from an earlier contact address is still the notification",
  );
  assert.equal(threadState([note, { ...mail("x", true), messageId: null }], ROW), "answered");
});

test("M9: the first reply quotes the stored message, a later one does not", () => {
  assert.equal(
    replyBody("Thanks", "line one\nline two", true),
    "Thanks\n\nYou wrote:\n> line one\n> line two",
  );
  assert.equal(replyBody("Thanks", "line one", false), "Thanks");
});
