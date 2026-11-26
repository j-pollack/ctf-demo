import assert from "node:assert/strict";
import { test } from "node:test";
import {
  notificationId,
  notificationSubject,
  replyBody,
  threadState,
} from "../lib/feedback-mail-text";

const GAME = "11111111-2222-4333-8444-555555555555";
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

test("the notification's Message-ID is derived from the row and the contact domain", () => {
  assert.equal(
    notificationId("row-1", "contact@ctf.example.test"),
    "feedback-row-1@ctf.example.test",
  );
});

test("M13: the state rule", () => {
  const note = mail("feedback-row-1@ctf.example.test", true);
  assert.equal(threadState([note], "row-1"), "waiting");
  assert.equal(threadState([note, mail("a", true)], "row-1"), "answered");
  assert.equal(threadState([note, mail("a", true), mail("b", false)], "row-1"), "waiting");
  assert.equal(threadState([], "row-1"), "waiting");
  assert.equal(
    threadState([mail("feedback-row-1@moved.example.test", true)], "row-1"),
    "waiting",
    "a notification sent from an earlier contact address is still the notification",
  );
  assert.equal(threadState([note, { ...mail("x", true), messageId: null }], "row-1"), "answered");
});

test("M9: the first reply quotes the stored message, a later one does not", () => {
  assert.equal(
    replyBody("Thanks", "line one\nline two", true),
    "Thanks\n\nYou wrote:\n> line one\n> line two",
  );
  assert.equal(replyBody("Thanks", "line one", false), "Thanks");
});
