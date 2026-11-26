import { createHmac } from "node:crypto";
import { db } from "./db";
import { EMAIL_MAX, MESSAGE_MAX, NAME_MAX } from "./feedback-limits";
import { transaction } from "./games";
import { GameError } from "./policy";

const CONTACTS_PER_SENDER_HOUR = 5;
const REPORTS_PER_SENDER_HOUR = 10;
const CONTACTS_PER_DAY = 200;
const LIST_LIMIT = 50;
const FEEDBACK_LOCK = 713902;
// The first four groups of an IPv6 address: a client can change the rest freely.
const IPV6_GROUPS = 4;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REPORT_KINDS = ["bug", "monitor", "other"] as const;

export type Feedback =
  | { kind: "contact"; name: string; email: string; message: string }
  | {
      kind: (typeof REPORT_KINDS)[number];
      gameId: string;
      sessionId: string | null;
      message: string;
    };

function text(value: unknown, field: string, max: number) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  // Postgres cannot store a NUL character in text.
  if (!trimmed || trimmed.length > max || trimmed.includes("\u0000"))
    throw new GameError(`Enter a valid ${field}.`);
  return trimmed;
}
function uuid(value: unknown, field: string) {
  if (typeof value !== "string" || !UUID.test(value)) throw new GameError(`Invalid ${field}.`);
  return value;
}

export function parseFeedback(data: Record<string, unknown>): Feedback {
  const message = text(data.message, "message", MESSAGE_MAX);
  if (data.kind === "contact") {
    if (data.gameId !== undefined || data.sessionId !== undefined)
      throw new GameError("A message cannot name a run.");
    const email = text(data.email, "email", EMAIL_MAX);
    if (!EMAIL.test(email)) throw new GameError("Enter a valid email.");
    return { kind: "contact", name: text(data.name, "name", NAME_MAX), email, message };
  }
  const kind = REPORT_KINDS.find((value) => value === data.kind);
  if (!kind) throw new GameError("Unknown kind of message.");
  const sessionId = data.sessionId === undefined ? null : uuid(data.sessionId, "session");
  return { kind, gameId: uuid(data.gameId, "run"), sessionId, message };
}

export function reportSender(userId: string) {
  return `user:${userId}`;
}

// The first x-forwarded-for entry is the one Vercel sets itself. Only a keyed hash is stored.
// ponytail: a plain split on ":" is wrong for an address that compresses zeros inside its first
// four groups; normalise with node:net if that matters.
export function contactSender(headers: Headers, secret: string) {
  const address = headers.get("x-forwarded-for")?.split(",")[0].trim().toLowerCase() || "";
  if (!address) return "ip:unknown";
  const key = address.includes(":") ? address.split(":").slice(0, IPV6_GROUPS).join(":") : address;
  return `ip:${createHmac("sha256", secret).update(`feedback-ip:${key}`).digest("hex")}`;
}

// One global lock makes the count and the insert atomic, so parallel requests cannot exceed a limit.
export async function saveFeedback(feedback: Feedback, userId: string | null, sender: string) {
  const contact = feedback.kind === "contact";
  const rowCount = await transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [FEEDBACK_LOCK]);
    const result = await client.query(
      `INSERT INTO ctf.feedback(kind,name,email,message,user_id,game_id,session_id,sender)
     SELECT $1,$2,$3,$4,$5,$6,$7,$8
     WHERE (SELECT count(*) FROM ctf.feedback WHERE sender=$8 AND created_at>now()-interval '1 hour') < $9
       AND ($1<>'contact' OR
         (SELECT count(*) FROM ctf.feedback WHERE kind='contact' AND created_at>now()-interval '1 day') < $10)`,
      [
        feedback.kind,
        contact ? feedback.name : null,
        contact ? feedback.email : null,
        feedback.message,
        userId,
        contact ? null : feedback.gameId,
        contact ? null : feedback.sessionId,
        sender,
        contact ? CONTACTS_PER_SENDER_HOUR : REPORTS_PER_SENDER_HOUR,
        CONTACTS_PER_DAY,
      ],
    );
    return result.rowCount;
  });
  if (!rowCount) throw new GameError("Too many messages. Try again later.", 429);
}

export type FeedbackRow = {
  id: string;
  kind: string;
  name: string | null;
  email: string | null;
  accountEmail: string | null;
  message: string;
  gameId: string | null;
  sessionId: string | null;
  ordinal: number | null;
  createdAt: Date;
};

// The first session's id equals the run id, so the ordinal is what makes a session readable.
export async function listFeedback() {
  const { rows } = await db.query<FeedbackRow>(
    `SELECT f.id,f.kind,f.name,f.email,u.email AS "accountEmail",f.message,
       f.game_id AS "gameId",f.session_id AS "sessionId",s.ordinal,f.created_at AS "createdAt"
     FROM ctf.feedback f
     LEFT JOIN ctf."user" u ON u.id=f.user_id
     LEFT JOIN ctf.agent_sessions s ON s.id=f.session_id
     ORDER BY f.created_at DESC LIMIT $1`,
    [LIST_LIMIT],
  );
  return rows;
}
