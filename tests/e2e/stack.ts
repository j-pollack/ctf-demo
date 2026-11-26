import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { after } from "node:test";
import { setTimeout } from "node:timers/promises";
import { Pool } from "pg";

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
    .map((line) => JSON.parse(line) as Record<string, string>);

// A fresh address per call, so one test's mail is never mistaken for another's.
export const newEmail = (label: string) => `${label}-${randomUUID().slice(0, 8)}@example.invalid`;

// The link in the newest sign-in mail to this address. The mail is sent after the response.
export async function signInLink(email: string) {
  for (let i = 0; i < 100; i++) {
    const sent = lines(mailFile).filter((mail) => mail.to === email);
    if (sent.length) return sent[sent.length - 1].link;
    await setTimeout(100);
  }
  throw new Error(`No sign-in mail reached ${email}.`);
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

// Extra headers for a new browser context. A deployment's proxy tells the app each visitor's
// address, and Better Auth rate-limits magic-link requests per address. This stack has no proxy,
// so each context gets an address of its own, unique across the run, from 198.18.0.0/15. The
// counter lives in a file because every test file is a separate process, run one at a time.
export function visitorHeaders() {
  const n = Number(readFileSync(visitorFile, "utf8") || 0) + 1;
  writeFileSync(visitorFile, String(n));
  return { "x-forwarded-for": `198.18.${n >> 8}.${n & 255}` };
}
