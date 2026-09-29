/**
 * Telling people something happened, when they are not looking at the app.
 *
 * Until this existed, the only way anyone learned of a new job, an approval
 * waiting on them, or a plumber booked for Thursday was the fifteen-second poll
 * in a browser tab they happened to have open. That quietly undid the promises
 * the rest of the app makes: an emergency that skips the approval queue and goes
 * straight to the first-choice vendor has not gone anywhere if the vendor is not
 * told.
 *
 * Two channels, both plain HTTPS calls so this runs the same on Bun and on Node:
 *
 *   email   Resend, when RESEND_API_KEY is set
 *   text    Twilio, when TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM are
 *           set — and only ever for urgent things. A text that arrives for every
 *           reply is a text that gets muted before the gas leak.
 *
 * With neither configured, a notification is printed to the server log instead
 * ("logged"), which is also how a password-reset link reaches a developer running
 * the app locally. Every notification is recorded against the person it was for,
 * whichever way it went, so "were they told?" has an answer.
 *
 * Delivery never fails the request that caused it. A broken mail provider is a
 * reason to log, not a reason to refuse to record that the boiler was fixed.
 */
import { db, isRemote, type User } from "./db";

export type Delivery = "sent" | "logged" | "failed";

export interface Note {
  /** What kind of event this is — used for throttling and shown in the feed. */
  kind: string;
  subject: string;
  body: string;
  ticketId?: number | null;
  /** Worth a text message as well as an email: emergencies, and nothing else. */
  urgent?: boolean;
  /**
   * A value that must not be stored or logged in production — a password-reset
   * token. It is replaced with "[redacted]" everywhere except the message
   * actually sent.
   */
  secret?: string;
  /**
   * Skip this if the same person was already told about the same kind of thing
   * on the same thread within this many minutes. A back-and-forth of ten replies
   * is one email, not ten.
   */
  throttleMinutes?: number;
}

const TIMEOUT_MS = 5000;

/* ------------------------------------------------------------ where links go */

/**
 * The front end's address, for links in messages.
 *
 * APP_URL wins when set. Otherwise it is learned from traffic: the Origin of a
 * cross-origin front end (GitHub Pages), or the API's own origin when it also
 * serves the page. Set APP_URL in production — a link built from whichever
 * request happened to come in last is fine for a single deployment and wrong
 * for anything cleverer.
 */
let learnedOrigin = "";
let warned = false;

export function configuredAppUrl(): string {
  return process.env.APP_URL?.trim().replace(/\/$/, "") ?? "";
}

export function rememberOrigin(origin: string) {
  if (!origin) return;
  learnedOrigin = origin.replace(/\/$/, "");
  if (isRemote && !configuredAppUrl() && !warned) {
    warned = true;
    console.warn("[notify] APP_URL is not set; links in notifications will use the address "
      + "requests arrive on. Set it to the front end's public URL.");
  }
}

export function appUrl(): string {
  return configuredAppUrl() || learnedOrigin;
}

export function ticketLink(ticketId: number): string {
  const base = appUrl();
  return base ? `${base}/#ticket=${ticketId}` : "";
}

/* -------------------------------------------------------------- transports */

const emailConfigured = () => Boolean(process.env.RESEND_API_KEY?.trim());
const smsConfigured = () =>
  Boolean(process.env.TWILIO_ACCOUNT_SID?.trim()
    && process.env.TWILIO_AUTH_TOKEN?.trim()
    && process.env.TWILIO_FROM?.trim());

/** Which channels are really wired up, for the account screen to say so. */
export function channels() {
  return { email: emailConfigured(), sms: smsConfigured() };
}

function redact(text: string, secret?: string) {
  return secret ? text.split(secret).join("[redacted]") : text;
}

/**
 * The stand-in for a mail provider. Locally the whole message is printed — that
 * is the point, it is how a developer gets a reset link. Against a production
 * database the secret is withheld, because a log is read by more people than
 * the one it was meant for.
 */
function logInstead(channel: string, to: string, subject: string, body: string, secret?: string) {
  const text = isRemote ? redact(body, secret) : body;
  console.log(`[notify] ${channel} to ${to}: ${subject}\n${text}\n[/notify]`);
  return "logged" as const;
}

async function sendEmail(to: string, subject: string, body: string, secret?: string): Promise<Delivery> {
  if (!emailConfigured()) return logInstead("email", to, subject, body, secret);
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.RESEND_API_KEY!.trim()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.NOTIFY_FROM?.trim() || "knoknok <notifications@knoknok.app>",
        to: [to],
        subject,
        text: body,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error("[notify] email failed", res.status, redact(await res.text(), secret));
      return "failed";
    }
    return "sent";
  } catch (err) {
    console.error("[notify] email failed", err);
    return "failed";
  }
}

async function sendSms(to: string, body: string, secret?: string): Promise<Delivery> {
  if (!smsConfigured()) return logInstead("sms", to, "(text)", body, secret);
  const sid = process.env.TWILIO_ACCOUNT_SID!.trim();
  const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN!.trim()}`).toString("base64");
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        authorization: `Basic ${auth}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        To: to,
        From: process.env.TWILIO_FROM!.trim(),
        // A text is read on a lock screen: the subject line and the link, not
        // the whole email.
        Body: body.slice(0, 600),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error("[notify] sms failed", res.status, await res.text());
      return "failed";
    }
    return "sent";
  } catch (err) {
    console.error("[notify] sms failed", err);
    return "failed";
  }
}

/* ------------------------------------------------------------- recipients */

/**
 * Tell one person something.
 *
 * Returns false when it was throttled away, true otherwise — including when the
 * person has no email or phone on file, because the record of what they would
 * have been told is still written and still shows in their feed.
 */
export async function notifyUser(userId: number, note: Note): Promise<boolean> {
  const user = await db.get<Pick<User, "id" | "email" | "phone">>(
    "SELECT id, email, phone FROM users WHERE id = ?", [userId]);
  if (!user) return false;

  if (note.throttleMinutes) {
    const recent = await db.get(
      `SELECT 1 AS x FROM notifications
        WHERE user_id = ? AND kind = ? AND ticket_id IS ?
          AND created_at > datetime('now', ?)`,
      [userId, note.kind, note.ticketId ?? null, `-${note.throttleMinutes} minutes`],
    );
    if (recent) return false;
  }

  // The email is the full message; the text is the headline and the link.
  const [email, sms] = await Promise.all([
    user.email ? sendEmail(user.email, note.subject, note.body, note.secret) : null,
    note.urgent && user.phone
      ? sendSms(user.phone, `${note.subject}${linkLine(note.body)}`, note.secret)
      : null,
  ]);

  await db.run(
    `INSERT INTO notifications (user_id, ticket_id, kind, subject, body, email_status, sms_status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [userId, note.ticketId ?? null, note.kind, note.subject, redact(note.body, note.secret),
     email, sms],
  );
  return true;
}

/** The last URL in a message, on its own line — what a text message keeps. */
function linkLine(body: string) {
  const urls = body.match(/https?:\/\/\S+/g);
  return urls?.length ? `\n${urls[urls.length - 1]}` : "";
}

export type Party = "tenant" | "landlord" | "vendor";

/**
 * Tell the people on a ticket, by role, leaving out whoever caused it.
 *
 * Each party is checked against the access they have *now*, not the access
 * they had when the ticket was raised: a tenant who has moved out, or a vendor
 * a landlord has dropped, is not told about work they can no longer open.
 */
export async function notifyTicket(
  ticketId: number,
  parties: Party[],
  note: Omit<Note, "ticketId">,
  exceptUserId: number | null = null,
): Promise<number> {
  const t = await db.get<{
    tenant_id: number | null; assigned_vendor_id: number | null; landlord_id: number | null;
    property_id: number; tenant_here: number | null; vendor_here: number | null;
  }>(
    `SELECT t.tenant_id, t.assigned_vendor_id, t.property_id, p.landlord_id,
            (SELECT 1 FROM users u WHERE u.id = t.tenant_id AND u.property_id = t.property_id)
              AS tenant_here,
            (SELECT 1 FROM users v WHERE v.id = t.assigned_vendor_id
               AND (EXISTS (SELECT 1 FROM property_vendors pv
                            WHERE pv.vendor_id = v.id AND pv.property_id = t.property_id)
                 OR EXISTS (SELECT 1 FROM landlord_vendors lv
                            WHERE lv.vendor_id = v.id AND lv.landlord_id = p.landlord_id)))
              AS vendor_here
       FROM tickets t JOIN properties p ON p.id = t.property_id
      WHERE t.id = ?`,
    [ticketId],
  );
  if (!t) return 0;

  const who = new Set<number>();
  if (parties.includes("tenant") && t.tenant_id && t.tenant_here) who.add(t.tenant_id);
  if (parties.includes("landlord") && t.landlord_id) who.add(t.landlord_id);
  if (parties.includes("vendor") && t.assigned_vendor_id && t.vendor_here) {
    who.add(t.assigned_vendor_id);
  }
  if (exceptUserId !== null) who.delete(exceptUserId);

  const link = ticketLink(ticketId);
  const body = link ? `${note.body}\n\n${link}` : note.body;
  const sent = await Promise.all(
    [...who].map((id) => notifyUser(id, { ...note, body, ticketId })),
  );
  return sent.filter(Boolean).length;
}

/** What this person has been told recently, newest first. */
export function recentNotifications(userId: number, limit = 20) {
  return db.all<{
    id: number; ticket_id: number | null; kind: string; subject: string; body: string;
    email_status: Delivery | null; sms_status: Delivery | null; created_at: string;
  }>(
    `SELECT id, ticket_id, kind, subject, body, email_status, sms_status, created_at
       FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?`,
    [userId, limit],
  );
}

/* ------------------------------------------------------------ validation */

/*
 * Both parsers answer three ways: a cleaned value, null for "cleared", or false
 * for "that is not one". Not-given is the caller's business — check undefined
 * before calling.
 */

/** A plausible address, lower-cased. Deliberately loose — the provider decides. */
export function parseEmail(input: unknown): string | null | false {
  const s = String(input ?? "").trim().toLowerCase();
  if (!s) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254 ? s : false;
}

/**
 * A phone number in the shape a text provider wants: digits with an optional
 * leading +. Spaces, dashes, dots and brackets are how people write numbers, so
 * they are dropped rather than refused.
 */
export function parsePhone(input: unknown): string | null | false {
  const s = String(input ?? "").replace(/[\s().-]/g, "");
  if (!s) return null;
  return /^\+?\d{7,15}$/.test(s) ? s : false;
}
