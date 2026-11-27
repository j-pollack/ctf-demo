import assert from "node:assert/strict";
import { test } from "node:test";
import { CONTACT, EXPECTED, FAILURES, TOKEN, read, setupFeedbackMail } from "./feedback-mail-setup";

const MIGRATION = "037-feedback-mail.sql";

test("feedback mail client and notification", { timeout: 180_000 }, async (t) => {
  const {
    pool,
    fake,
    logged,
    listed,
    post,
    rows,
    threadOf,
    until,
    contact,
    alice,
    gameId,
    insertRow,
    bossHeaders,
  } = await setupFeedbackMail(t);
  const { sendMail, readThreads } = await import("../../lib/fastmail");
  const { notifyFeedback, replyToFeedback } = await import("../../lib/feedback-mail");
  const { notificationId } = await import("../../lib/feedback-mail-text");

  await t.test("M15: migration 037 applies twice and setup and runbook name it", async () => {
    const sql = await read(`../../db/migrations/${MIGRATION}`);
    await pool.query(sql);
    await pool.query(sql);
    assert.ok(listed.includes(MIGRATION), "setup lists 037");
    assert.ok(
      listed.indexOf(MIGRATION) === listed.indexOf("036-feedback.sql") + 1,
      "037 follows 036",
    );
    assert.match(await read("../../deploy/operations.md"), /037-feedback-mail/);
  });

  const mail = {
    to: "ada@example.com",
    replyTo: undefined,
    subject: "Hello",
    text: "Body text",
  };

  await t.test("M17: the client sends the token and returns the thread id", async () => {
    const { threadId } = await sendMail({ ...mail, messageId: "id-1@ctf.example.test" });
    const [sent] = fake.submissions;
    assert.equal(sent.rcptTo[0], "ada@example.com");
    assert.equal(sent.email.threadId, threadId);
    assert.ok(fake.requests.length >= 3 && fake.requests.every((url) => url.includes("fastmail")));
    const threads = await readThreads([threadId], { bodies: true });
    assert.deepEqual(
      threads.get(threadId)!.map((email) => [email.text, email.sent, email.from]),
      [["Body text", true, CONTACT]],
    );
  });

  await t.test("M17: each failure throws its own error and leaves no draft", async () => {
    for (const failure of FAILURES) {
      fake.reset();
      fake.controls.fail = failure;
      await assert.rejects(sendMail(mail), EXPECTED[failure], failure);
      assert.equal(fake.emails.length, 0, `${failure} leaves no draft`);
    }
    for (const failure of FAILURES.slice(0, 4)) {
      fake.reset();
      fake.controls.fail = failure;
      await assert.rejects(
        readThreads(["thread-1"], { bodies: false }),
        EXPECTED[failure],
        failure,
      );
    }
  });

  await t.test("M17: one deadline covers every request in an operation", async () => {
    const timed = async (run: (signal: AbortSignal) => Promise<unknown>, ms: number) => {
      const started = Date.now();
      await assert.rejects(run(AbortSignal.timeout(ms)), EXPECTED.hang);
      return Date.now() - started;
    };
    fake.controls.fail = "hang";
    assert.ok((await timed((signal) => sendMail(mail, { signal }), 150)) < 1000);
    assert.ok(
      (await timed((signal) => readThreads(["thread-1"], { bodies: false }, { signal }), 150)) <
        1000,
    );
    // The session answers after 200 ms of a 300 ms deadline, so the API request has about 100 ms
    // left. A timeout per request would let it hang for a further 300 ms.
    fake.controls.hold = () => new Promise((resolve) => setTimeout(resolve, 200));
    const elapsed = await timed((signal) => sendMail(mail, { signal }), 300);
    assert.ok(elapsed >= 280 && elapsed < 800, `took ${elapsed} ms`);
  });

  await t.test("P2a: a draft is destroyed when the submission fails in any way", async () => {
    for (const failure of [
      "submission-not-created",
      "submission-method-error",
      "submission-missing",
    ] as const) {
      fake.reset();
      fake.controls.fail = failure;
      await assert.rejects(sendMail(mail), EXPECTED[failure], failure);
      assert.deepEqual(fake.emails, [], `${failure} leaves no draft`);
      assert.equal(fake.submissions.length, 0);
    }
  });

  await t.test("an error while filing a sent email does not undo the send", async () => {
    fake.controls.implicitError = true;
    const sent = await sendMail(mail);
    assert.ok(sent.threadId, "the send is reported as a success");
    assert.equal(fake.submissions.length, 1);
    assert.equal(fake.emails.length > 0, true, "the sent email is not destroyed");
    assert.ok(fake.emails.every((email) => email.threadId === sent.threadId));
  });

  await t.test("P2d: the address rule accepts what a mail address may hold", async () => {
    await sendMail({ ...mail, to: "o'neil@example.com", replyTo: "a+b_c.d!e@sub.example.com" });
    assert.deepEqual(fake.submissions[0].rcptTo, ["o'neil@example.com"]);
    const requests = fake.requests.length;
    for (const to of [
      "a,b@example.com",
      "a;b@example.com",
      "<a@example.com>",
      'a"@example.com',
      "(a)@example.com",
      "a:b@example.com",
      "a\\b@example.com",
      "a b@example.com",
      "\u00e9@example.com",
      "a@exa_mple.com",
      "a@b@example.com",
    ]) {
      await assert.rejects(sendMail({ ...mail, to }), /address/i, to);
      await assert.rejects(sendMail({ ...mail, replyTo: to }), /address/i, to);
    }
    assert.equal(fake.requests.length, requests, "no refused address reached Fastmail");
  });

  await t.test(
    "readThreads: a missing Message-ID or From never becomes the word undefined",
    async () => {
      const { threadId } = await sendMail(mail);
      fake.seed({ from: "", mailbox: "inbox", threadId, messageId: null, text: "one" });
      fake.seed({
        from: "x@example.com",
        mailbox: "inbox",
        threadId,
        messageId: null,
        text: "two",
      });
      const mails = (await readThreads([threadId], { bodies: true })).get(threadId)!;
      assert.deepEqual(
        mails.map((entry) => [entry.messageId === null, entry.from, entry.text]),
        [
          [false, CONTACT, "Body text"],
          [true, "", "one"],
          [true, "x@example.com", "two"],
        ],
        "two emails without a Message-ID are two messages",
      );
      assert.ok(!JSON.stringify(mails).includes("undefined"));
    },
  );

  await t.test("readThreads: HTML-only means no plain text part", async () => {
    const { threadId } = await sendMail(mail);
    fake.seed({ from: "a@example.com", mailbox: "inbox", threadId, html: true, text: "" });
    fake.seed({
      from: "b@example.com",
      mailbox: "inbox",
      threadId,
      html: true,
      plainToo: true,
      text: "plain part",
    });
    const [, htmlOnly, both] = (await readThreads([threadId], { bodies: true })).get(threadId)!;
    assert.deepEqual([htmlOnly.htmlOnly, htmlOnly.text], [true, ""]);
    assert.deepEqual([both.htmlOnly ?? false, both.text], [false, "plain part"]);
  });

  await t.test(
    "M1: the response comes before Fastmail answers, then one email is submitted",
    async () => {
      const held: { release?: () => void } = {};
      fake.controls.hold = () => new Promise<void>((resolve) => (held.release = resolve));
      assert.equal(await post(contact), 200);
      const [row] = await rows();
      assert.equal(await threadOf(row.id), null, "Fastmail has not answered yet");
      assert.equal(fake.submissions.length, 0);
      // The send starts after the response. A release before it reaches the hold would be lost
      // and the send would then wait for ever.
      await until(() => held.release !== undefined);
      held.release?.();
      await until(async () => (await threadOf(row.id)) !== null);
      const [{ email, mailFrom, rcptTo }] = fake.submissions;
      assert.equal(fake.submissions.length, 1);
      assert.equal(mailFrom, CONTACT);
      assert.deepEqual(rcptTo, [CONTACT]);
      assert.equal(email.from, CONTACT);
      assert.deepEqual(email.replyTo, ["ada@example.com"]);
      assert.equal(email.messageId, notificationId(row.id, CONTACT));
      assert.ok(email.messageId.length <= 64, "within the length Fastmail accepts");
      assert.equal(email.subject, "[CTF] Contact from Ada");
      assert.equal(email.text, "Hello");
      assert.equal(await threadOf(row.id), email.threadId);
    },
  );

  await t.test("M2: a report replies to the account and carries the run and session", async () => {
    const report = { kind: "bug", gameId, sessionId: gameId, message: "Broken" };
    assert.equal(await post(report, alice.cookie), 200);
    const [row] = await rows();
    await until(async () => (await threadOf(row.id)) !== null);
    const [{ email }] = fake.submissions;
    assert.deepEqual(email.replyTo, [alice.email]);
    assert.equal(email.subject, `[CTF] Report (bug) on run ${gameId.slice(0, 8)}`);
    assert.ok(email.text.includes(`Run: ${gameId}`));
    assert.ok(email.text.includes(`Session: ${gameId}`));
  });

  await t.test("M3: with either variable missing nothing leaves the process", async () => {
    for (const name of ["FASTMAIL_API_TOKEN", "CONTACT_EMAIL"]) {
      await pool.query("DELETE FROM ctf.feedback");
      process.env.FASTMAIL_API_TOKEN = TOKEN;
      process.env.CONTACT_EMAIL = CONTACT;
      delete process.env[name];
      assert.equal(await post(contact), 200);
      const [row] = await rows();
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(row.mail_thread_id, null, name);
      assert.deepEqual(fake.requests, [], name);
    }
  });

  await t.test(
    "M4: each Fastmail failure still stores the row and logs one clean line",
    async () => {
      for (const failure of FAILURES) {
        fake.reset();
        logged.length = 0;
        await pool.query("DELETE FROM ctf.feedback");
        fake.controls.fail = failure;
        assert.equal(await post(contact), 200, failure);
        await until(() => logged.length === 1);
        const [row] = await rows();
        assert.equal(row.mail_thread_id, null, failure);
        assert.equal(fake.emails.length, 0, `${failure} leaves no draft`);
        assert.equal(logged.length, 1);
        assert.match(logged[0], EXPECTED[failure], failure);
        for (const secret of [TOKEN, "ada@example.com", CONTACT, "Hello"])
          assert.ok(!logged[0].includes(secret), `${failure} log leaks ${secret}`);
      }
    },
  );

  await t.test("M4: a hanging Fastmail times out, logs and leaves the thread empty", async () => {
    await pool.query(
      `INSERT INTO ctf.feedback(kind,name,email,message,sender)
       VALUES('contact','Ada','ada@example.com','Hello','ip:test')`,
    );
    fake.controls.fail = "hang";
    const [row] = await rows();
    const started = Date.now();
    await notifyFeedback(row.id, { signal: AbortSignal.timeout(100) });
    assert.ok(Date.now() - started < 1000, "returns at its deadline, not the default 10 s");
    assert.equal(await threadOf(row.id), null);
    assert.equal(logged.length, 1);
    assert.match(logged[0], EXPECTED.hang);
    assert.ok(!logged[0].includes(TOKEN) && !logged[0].includes("ada@example.com"));
  });

  await t.test(
    "P2d: an address the rule refuses still gets a notification, without reply-to",
    async () => {
      const id = await insertRow({ email: "a,b@example.com" });
      await notifyFeedback(id);
      const { email } = fake.submissions[0];
      assert.deepEqual(email.replyTo, []);
      assert.ok(email.text.includes("a,b@example.com"), "the address is given as text");
      assert.notEqual(await threadOf(id), null);
      await assert.rejects(replyToFeedback(bossHeaders, id, "Hi"), /address/i);
      assert.equal(fake.submissions.length, 1, "replies stay refused");
    },
  );
});
