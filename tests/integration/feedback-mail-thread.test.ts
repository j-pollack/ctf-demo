import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { CONTACT, setupFeedbackMail } from "./feedback-mail-setup";

test("feedback mail thread, reply and states", { timeout: 180_000 }, async (t) => {
  const {
    pool,
    fake,
    rows,
    threadOf,
    guestHeaders,
    aliceHeaders,
    bossHeaders,
    insertRow,
    notified,
    lastSent,
  } = await setupFeedbackMail(t);
  const { readThreads } = await import("../../lib/fastmail");
  const { feedbackThread, replyToFeedback, setFeedbackClosed, feedbackStates } =
    await import("../../lib/feedback-mail");
  const { listFeedback } = await import("../../lib/feedback");
  const { notificationId } = await import("../../lib/feedback-mail-text");
  const { GameError } = await import("../../lib/policy");
  const noteOf = (id: string) => notificationId(id, CONTACT);

  await t.test(
    "M6: the thread starts with the stored message and lists replies in order",
    async () => {
      const { id } = await notified();
      await replyToFeedback(bossHeaders, id, "Thanks, looking now");
      fake.seed({
        from: "ada@example.com",
        mailbox: "inbox",
        text: "It works now",
        inReplyTo: [lastSent().messageId],
      });
      const data = (await feedbackThread(bossHeaders, id))!;
      assert.equal(data.note, null);
      assert.deepEqual(
        data.messages.map((message) => [message.from, message.ours, message.text.split("\n")[0]]),
        [
          ["ada@example.com", false, "Hello"],
          [CONTACT, true, "Thanks, looking now"],
          ["ada@example.com", false, "It works now"],
        ],
      );
    },
  );

  await t.test(
    "M7: forged senders are theirs and hidden or duplicate copies are not shown",
    async () => {
      const { id, thread } = await notified();
      const forged = fake.seed({
        from: CONTACT,
        mailbox: "inbox",
        threadId: thread,
        text: "forged",
      });
      for (const mailbox of ["drafts", "junk", "trash"] as const)
        fake.seed({ from: "x@example.com", mailbox, threadId: thread, text: mailbox });
      fake.seed({
        from: "x@example.com",
        mailbox: "inbox",
        threadId: thread,
        keywords: ["$draft"],
      });
      const mails = (await readThreads([thread], { bodies: true })).get(thread)!;
      assert.deepEqual(
        mails.map((mail) => [mail.messageId, mail.sent]),
        [
          [noteOf(id), true],
          [forged.messageId, false],
        ],
        "the notification has copies in Sent and the Inbox and appears once, as ours",
      );
    },
  );

  await t.test(
    "M8: the stored message shows with the matching note and nothing throws",
    async () => {
      const bare = await insertRow();
      assert.equal((await feedbackThread(bossHeaders, bare))!.note, "no-thread");
      const { id } = await notified();
      fake.controls.fail = "api-500";
      const failing = (await feedbackThread(bossHeaders, id))!;
      assert.equal(failing.note, "unreadable");
      assert.deepEqual(
        failing.messages.map((message) => message.text),
        ["Hello"],
      );
      delete process.env.FASTMAIL_API_TOKEN;
      assert.equal((await feedbackThread(bossHeaders, id))!.note, "not-set-up");
      assert.equal(await feedbackThread(bossHeaders, randomUUID()), null);
      assert.equal(await feedbackThread(bossHeaders, "not-a-uuid"), null);
    },
  );

  await t.test(
    "M9: a reply threads onto the conversation and quotes only the first time",
    async () => {
      const { id } = await notified();
      await replyToFeedback(bossHeaders, id, "  First answer ");
      const first = fake.submissions.at(-1)!;
      assert.equal(first.mailFrom, CONTACT);
      assert.deepEqual(first.rcptTo, ["ada@example.com"]);
      assert.deepEqual(first.email.to, ["ada@example.com"]);
      assert.equal(first.email.subject, "Re: [CTF] Contact from Ada");
      assert.deepEqual(first.email.inReplyTo, [noteOf(id)]);
      assert.deepEqual(first.email.references, [noteOf(id)]);
      assert.equal(first.email.text, "First answer\n\nYou wrote:\n> Hello");
      // A sender's mail client picks its own Message-ID, and many are longer than the 64 characters
      // Fastmail accepts in the header form of In-Reply-To.
      const theirs = fake.seed({
        from: "ada@example.com",
        mailbox: "inbox",
        inReplyTo: [first.email.messageId],
        messageId: `${"A".repeat(70)}@mail.outlook.example.com`,
      });
      await replyToFeedback(bossHeaders, id, "Second answer");
      const second = lastSent();
      assert.deepEqual(second.inReplyTo, [theirs.messageId]);
      assert.deepEqual(second.references, [noteOf(id), first.email.messageId, theirs.messageId]);
      assert.equal(second.text, "Second answer");
      assert.equal(second.threadId, first.email.threadId);
    },
  );

  await t.test(
    "M10: a row with no thread gets a reply with no headers and keeps the new thread",
    async () => {
      const id = await insertRow();
      await replyToFeedback(bossHeaders, id, "Hi");
      const sent = lastSent();
      assert.deepEqual([sent.inReplyTo, sent.references], [[], []]);
      assert.equal(await threadOf(id), sent.threadId);
    },
  );

  await t.test("M11: bad replies, ids, configuration and addresses send nothing", async () => {
    const id = await insertRow();
    const refused = async (call: Promise<unknown>) => {
      await assert.rejects(call);
      assert.equal(fake.submissions.length, 0);
    };
    for (const text of ["", "   ", "a".repeat(5001), "nul\u0000here", undefined])
      await refused(replyToFeedback(bossHeaders, id, text));
    await refused(replyToFeedback(bossHeaders, randomUUID(), "Hi"));
    await refused(replyToFeedback(bossHeaders, "nope", "Hi"));
    for (const email of [
      "a,b@example.com",
      "a;b@example.com",
      "<a@example.com>",
      'a"b@example.com',
      "a b@example.com",
    ])
      await refused(replyToFeedback(bossHeaders, await insertRow({ email }), "Hi"));
    delete process.env.CONTACT_EMAIL;
    await refused(replyToFeedback(bossHeaders, id, "Hi"));
  });

  await t.test("M12: only a signed-in admin reaches Fastmail or the row", async () => {
    const id = await insertRow({ thread: "thread-1" });
    const callers = [new Headers(), guestHeaders, aliceHeaders];
    for (const headers of callers) {
      for (const call of [
        () => feedbackThread(headers, id),
        () => replyToFeedback(headers, id, "Hi"),
        () => setFeedbackClosed(headers, id, true),
      ])
        await assert.rejects(call(), GameError);
    }
    assert.deepEqual(fake.requests, []);
    assert.equal((await rows())[0].closed_at, null);
  });

  await t.test("M13: list states follow the newest email and time out cleanly", async () => {
    const thread = (messages: [string, "sent" | "inbox"][], id: string) => {
      const first = fake.seed({ from: CONTACT, mailbox: "sent", messageId: noteOf(id) });
      for (const [from, mailbox] of messages)
        fake.seed({ from, mailbox, threadId: first.threadId });
      return first.threadId;
    };
    const ids = Object.fromEntries(
      await Promise.all(
        ["quiet", "answered", "theirs", "forged"].map(async (name) => [name, randomUUID()]),
      ),
    );
    const threads: Record<string, string> = {
      quiet: thread([], ids.quiet),
      answered: thread([[CONTACT, "sent"]], ids.answered),
      theirs: thread(
        [
          [CONTACT, "sent"],
          ["ada@example.com", "inbox"],
        ],
        ids.theirs,
      ),
      forged: thread(
        [
          [CONTACT, "sent"],
          [CONTACT, "inbox"],
        ],
        ids.forged,
      ),
    };
    await pool.query("DELETE FROM ctf.feedback");
    for (const [name, thread] of Object.entries(threads)) {
      await pool.query(
        `INSERT INTO ctf.feedback(id,kind,name,email,message,sender,mail_thread_id)
         VALUES($1,'contact','Ada','ada@example.com','Hello','ip:test',$2)`,
        [ids[name], thread],
      );
    }
    const unthreaded = await insertRow();
    const closed = await insertRow({ thread: threads.quiet, closed: true });
    const listed = await listFeedback();
    assert.deepEqual(await feedbackStates(listed), {
      [ids.quiet]: "waiting",
      [ids.answered]: "answered",
      [ids.theirs]: "waiting",
      [ids.forged]: "waiting",
      [unthreaded]: "waiting",
      [closed]: "closed",
    });
    fake.controls.fail = "hang";
    const started = Date.now();
    assert.deepEqual(await feedbackStates(listed, { signal: AbortSignal.timeout(100) }), {
      [unthreaded]: "waiting",
      [closed]: "closed",
    });
    assert.ok(Date.now() - started < 2000, "returns within its timeout");
  });

  await t.test("M14: closing and reopening set closed_at, and open rows list first", async () => {
    const oldOpen = await insertRow({ age: 120 });
    const newClosed = await insertRow({ closed: true, age: 1 });
    assert.deepEqual(
      (await listFeedback()).map((row) => row.id),
      [oldOpen, newClosed],
    );
    await setFeedbackClosed(bossHeaders, oldOpen, true);
    assert.notEqual((await listFeedback()).find((row) => row.id === oldOpen)!.closedAt, null);
    await setFeedbackClosed(bossHeaders, oldOpen, false);
    assert.equal((await listFeedback()).find((row) => row.id === oldOpen)!.closedAt, null);
    await assert.rejects(setFeedbackClosed(bossHeaders, randomUUID(), true), GameError);
  });

  await t.test(
    "P2c: moving CONTACT_EMAIL does not turn old notifications into replies",
    async () => {
      const { id, thread } = await notified();
      process.env.CONTACT_EMAIL = "contact@moved.example.test";
      const data = (await feedbackThread(bossHeaders, id))!;
      assert.deepEqual(
        data.messages.map((message) => message.text),
        ["Hello"],
        "the notification is still left out",
      );
      const [listed] = await listFeedback();
      assert.deepEqual(await feedbackStates([listed]), { [id]: "waiting" });
      await replyToFeedback(bossHeaders, id, "First answer");
      assert.equal(
        lastSent().text,
        "First answer\n\nYou wrote:\n> Hello",
        "the first reply still quotes",
      );
      assert.deepEqual(lastSent().inReplyTo, [noteOf(id)]);
      assert.equal(lastSent().threadId, thread);
    },
  );

  await t.test("a copy in the Inbox seeded first never beats the copy in Sent", async () => {
    const { thread } = await notified();
    fake.seed({
      from: "x@example.com",
      mailbox: "inbox",
      threadId: thread,
      messageId: "dup@x.test",
    });
    fake.seed({ from: CONTACT, mailbox: "sent", threadId: thread, messageId: "dup@x.test" });
    const copies = (await readThreads([thread], { bodies: false }))
      .get(thread)!
      .filter((mail) => mail.messageId === "dup@x.test");
    assert.deepEqual(
      copies.map((mail) => mail.sent),
      [true],
    );
  });

  await t.test(
    "a stored thread with no visible mail gets a plain reply and a fresh thread id",
    async () => {
      const id = await insertRow({ thread: "ghost-thread" });
      await replyToFeedback(bossHeaders, id, "Hi");
      const sent = lastSent();
      assert.deepEqual([sent.inReplyTo, sent.references], [[], []]);
      assert.ok(sent.text.includes("You wrote:"));
      assert.equal(await threadOf(id), sent.threadId);
    },
  );
});
