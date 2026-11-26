import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { after } from "node:test";
import { setTimeout } from "node:timers/promises";
import { Pool } from "pg";
import { failureEvents, newLines } from "../../scripts/test-e2e";

// Everything a journey needs from the stack it runs against. This is the faked stack: the app
// started by scripts/test-e2e.ts, mail read from the file its preload writes, and the runner's
// disposable Postgres.
function required(name: string) {
  const value = process.env[name];
  assert.ok(value, `${name} is not set. Use npm run test:e2e.`);
  return value;
}

export const baseUrl = required("E2E_BASE_URL");
assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
const violationsFile = required("E2E_VIOLATIONS_FILE");
const mailFile = required("E2E_MAIL_FILE");
const visitorFile = required("E2E_VISITOR_FILE");
const serverLog = required("E2E_SERVER_LOG");
const logCursor = required("E2E_LOG_CURSOR");

let opened: Pool | undefined;
// Opened on first use, after the same checks the runner makes: loopback and its own database.
export function pool() {
  if (opened) return opened;
  assert.equal(process.env.PGHOST, "127.0.0.1");
  assert.match(process.env.PGDATABASE ?? "", /^ctf_e2e_[a-f0-9]{32}$/);
  opened = new Pool({ max: 2, options: "-c search_path=ctf,public" });
  return opened;
}
after(() => opened?.end());

const lines = (file: string) =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Mail);

// A fresh address per call, so one test's mail is never mistaken for another's.
export const newEmail = (label: string) => `${label}-${randomUUID().slice(0, 8)}@example.invalid`;

export type Mail = Record<string, string | string[]>;

// The newest mail to this recipient with this subject. Mail is sent after the response, so this
// waits for it.
export async function mailTo(to: string, subject: string): Promise<Mail> {
  for (let i = 0; i < 100; i++) {
    const sent = lines(mailFile).filter((mail) => mail.to === to && mail.subject === subject);
    if (sent.length) return sent[sent.length - 1];
    await setTimeout(100);
  }
  throw new Error(`No mail with the subject "${subject}" reached ${to}.`);
}

export const contactEmail = required("CONTACT_EMAIL");

// The thread id the app stores once the notification is sent, which is after the response.
export async function threadIdOf(message: string) {
  for (let i = 0; i < 100; i++) {
    const { rows } = await pool().query(
      `SELECT mail_thread_id FROM ctf.feedback WHERE message=$1`,
      [message],
    );
    if (rows[0]?.mail_thread_id) return rows[0].mail_thread_id as string;
    await setTimeout(100);
  }
  throw new Error("The message never got a mail thread.");
}

const SIGN_IN_SUBJECT = "Your Capture the flag sign-in link";

// The link in the newest sign-in mail to this address.
export async function signInLink(email: string) {
  return (await mailTo(email, SIGN_IN_SUBJECT)).link as string;
}

export async function grantAdmin(email: string) {
  const { rowCount } = await pool().query(`UPDATE ctf."user" SET "isAdmin"=true WHERE email=$1`, [
    email,
  ]);
  assert.equal(rowCount, 1, `No account for ${email}.`);
}

// The violations recorded since the last take. The file is renamed first, so a line the server
// appends meanwhile lands in a new file instead of being lost.
export function takeViolations() {
  if (!existsSync(violationsFile)) return [];
  const taken = `${violationsFile}.taken`;
  renameSync(violationsFile, taken);
  const found = lines(taken);
  rmSync(taken);
  return found;
}

// The failure events the server has logged since the last take. The cursor is a byte offset in a
// file, because every test file is a separate process, and it moves only past whole lines.
export function takeServerFailures() {
  const { lines, offset } = newLines(
    readFileSync(serverLog),
    Number(readFileSync(logCursor, "utf8")),
  );
  writeFileSync(logCursor, String(offset));
  return failureEvents(lines);
}

// Extra headers for a new browser context. A deployment's proxy tells the app each visitor's
// address, and Better Auth rate-limits magic-link requests per address. This stack has no proxy,
// so each context gets an address of its own, unique across the run, from 198.18.0.0/15. The
// counter lives in a file because every test file is a separate process, run one at a time.
export function visitorHeaders() {
  const n = Number(readFileSync(visitorFile, "utf8") || 0) + 1;
  writeFileSync(visitorFile, String(n));
  return { "x-forwarded-for": `198.18.${n >> 8}.${n & 255}` };
}
