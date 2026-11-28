import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { after } from "node:test";
import { setTimeout } from "node:timers/promises";
import { Pool } from "pg";
import { failureEvents, newLines } from "../../scripts/test-e2e";

// Everything a journey needs from the stack it runs against. E2E_STACK unset is the faked stack:
// the app started by scripts/test-e2e.ts, mail read from the file its preload writes, and the
// runner's disposable Postgres. E2E_STACK=real is a deployed app with its own database. Each
// variable the faked stack needs is read when first used, so the real stack needs none of them.
assert.ok([undefined, "real"].includes(process.env.E2E_STACK), "E2E_STACK is real or unset.");
export const realStack = process.env.E2E_STACK === "real";

// How long a journey, a wait and a browser action may take. A real model and a real review take
// minutes: the journey limit covers one full review attempt, and a wait is bounded by the journey.
export const LIMITS = realStack
  ? { journeyMs: 12 * 60_000, waitMs: 10 * 60_000, actionMs: 60_000 }
  : { journeyMs: 90_000, waitMs: 15_000, actionMs: 15_000 };

const unavailable = (name: string): never => {
  throw new Error(`${name} is not available with E2E_STACK=real.`);
};

export function required(name: string) {
  const value = process.env[name];
  assert.ok(
    value,
    `${name} is not set. Use ${realStack ? "npm run test:e2e:real" : "npm run test:e2e"}.`,
  );
  return value;
}

export const baseUrl = required("E2E_BASE_URL");
if (realStack) assert.match(baseUrl, /^https:\/\//, "E2E_BASE_URL must be an https URL.");
else assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);

let opened: Pool | undefined;
// Opened on first use. The faked stack first makes the checks the runner makes: loopback and its
// own database. The real stack takes one connection string, with no startup options because a
// pooled endpoint refuses them, so its queries name the `ctf` schema.
export function pool() {
  if (opened) return opened;
  if (realStack) {
    opened = new Pool({ max: 2, connectionString: required("E2E_DATABASE_URL") });
    return opened;
  }
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
// The real stack has one member, because the app drops a "+label" from an address, and mail goes
// to Resend's test recipient.
export const newEmail = (label: string) =>
  realStack ? "delivered@resend.dev" : `${label}-${randomUUID().slice(0, 8)}@example.invalid`;

export type Mail = Record<string, string | string[]>;

// The newest mail to this recipient with this subject. Mail is sent after the response, so this
// waits for it.
export async function mailTo(to: string, subject: string): Promise<Mail> {
  if (realStack) return unavailable("mailTo");
  const mailFile = required("E2E_MAIL_FILE");
  for (let i = 0; i < 100; i++) {
    const sent = lines(mailFile).filter((mail) => mail.to === to && mail.subject === subject);
    if (sent.length) return sent[sent.length - 1];
    await setTimeout(100);
  }
  throw new Error(`No mail with the subject "${subject}" reached ${to}.`);
}

export const contactEmail = () =>
  realStack ? unavailable("contactEmail") : required("CONTACT_EMAIL");

// The thread id the app stores once the notification is sent, which is after the response.
export async function threadIdOf(message: string) {
  if (realStack) return unavailable("threadIdOf");
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

// Better Auth keeps the SHA-256 of a magic-link token, as unpadded base64url, and the member's
// email as JSON. A row is good for five minutes.
const LINK_LIFETIME_MS = 5 * 60_000;

// The link that signs this address in and lands on `next`. The faked stack reads it from the
// newest sign-in mail. The real stack has no inbox to read, so it writes the row Better Auth would
// have written and builds the verify URL. The token is a credential: it is masked under GitHub
// Actions and never printed otherwise.
export async function signInLink(email: string, next = "/play") {
  if (!realStack) return (await mailTo(email, SIGN_IN_SUBJECT)).link as string;
  const token = randomBytes(32).toString("base64url");
  if (process.env.GITHUB_ACTIONS) console.log(`::add-mask::${token}`);
  const now = new Date();
  await pool().query(
    `INSERT INTO ctf.verification (id, identifier, value, "expiresAt", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $5)`,
    [
      randomUUID(),
      createHash("sha256").update(token).digest("base64url"),
      JSON.stringify({ email }),
      new Date(now.getTime() + LINK_LIFETIME_MS),
      now,
    ],
  );
  const link = new URL("/api/auth/magic-link/verify", baseUrl);
  link.search = new URLSearchParams({ token, callbackURL: next }).toString();
  return link.toString();
}

export async function grantAdmin(email: string) {
  if (realStack) return unavailable("grantAdmin");
  const { rowCount } = await pool().query(`UPDATE ctf."user" SET "isAdmin"=true WHERE email=$1`, [
    email,
  ]);
  assert.equal(rowCount, 1, `No account for ${email}.`);
}

// The violations recorded since the last take. The file is renamed first, so a line the server
// appends meanwhile lands in a new file instead of being lost.
export function takeViolations() {
  if (realStack) return [];
  const violationsFile = required("E2E_VIOLATIONS_FILE");
  if (!existsSync(violationsFile)) return [];
  const taken = `${violationsFile}.taken`;
  renameSync(violationsFile, taken);
  const found = lines(taken);
  rmSync(taken);
  return found;
}

// The failure events the server has logged since the last take. The cursor is a byte offset in a
// file, because every test file is a separate process, and it moves only past whole lines.
function takeFailures(log: string, cursor: string) {
  const { lines, offset } = newLines(readFileSync(log), Number(readFileSync(cursor, "utf8")));
  writeFileSync(cursor, String(offset));
  return failureEvents(lines);
}

// The real stack's logs are on Vercel and Fly, which the test cannot read.
export const takeServerFailures = () =>
  realStack ? [] : takeFailures(required("E2E_SERVER_LOG"), required("E2E_LOG_CURSOR"));

// The same for the monitor worker's log, with a cursor of its own.
export const takeWorkerFailures = () =>
  realStack ? [] : takeFailures(required("E2E_WORKER_LOG"), required("E2E_WORKER_LOG_CURSOR"));

// Extra headers for a new browser context. A deployment's proxy tells the app each visitor's
// address, and Better Auth rate-limits magic-link requests per address. This stack has no proxy,
// so each context gets an address of its own, unique across the run, from 198.18.0.0/15. The
// counter lives in a file because every test file is a separate process, run one at a time.
// The real stack goes through Vercel's proxy, which sets the address, and skips the Preview toolbar
// that would add console errors and failed requests.
export function visitorHeaders(): Record<string, string> {
  if (realStack) return { "x-vercel-skip-toolbar": "1" };
  const visitorFile = required("E2E_VISITOR_FILE");
  const n = Number(readFileSync(visitorFile, "utf8") || 0) + 1;
  writeFileSync(visitorFile, String(n));
  return { "x-forwarded-for": `198.18.${n >> 8}.${n & 255}` };
}
