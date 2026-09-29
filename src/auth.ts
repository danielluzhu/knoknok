/**
 * Passwords, sessions, and sign-in throttling.
 *
 * Hashing uses scrypt from node:crypto rather than Bun.password, so the same
 * code runs on Bun locally and on Node in production.
 */
import { createHash, randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { db, type User } from "./db";

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const KEY_LENGTH = 64;
const SESSION_DAYS = 30;
const COOKIE = "knoknok_session";

/** Stored as `scrypt$<salt>$<key>`, both base64, so the scheme can change later. */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(plain, salt, KEY_LENGTH);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, keyB64] = stored.split("$");
  if (scheme !== "scrypt" || !saltB64 || !keyB64) return false;
  try {
    const expected = Buffer.from(keyB64, "base64");
    const actual = await scrypt(plain, Buffer.from(saltB64, "base64"), expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/* --------------------------------------------------------------- sessions */

export async function createSession(userId: number): Promise<string> {
  const token = randomBytes(32).toString("hex");
  await db.run(
    `INSERT INTO sessions (token, user_id, expires_at)
     VALUES (?, ?, datetime('now', '+${SESSION_DAYS} days'))`,
    [token, userId],
  );
  return token;
}

export async function destroySession(token: string): Promise<void> {
  await db.run("DELETE FROM sessions WHERE token = ?", [token]);
}

/** Sign this user out everywhere except the session they are using right now. */
export async function dropOtherSessions(userId: number, keepToken: string | null): Promise<void> {
  if (keepToken) {
    await db.run("DELETE FROM sessions WHERE user_id = ? AND token != ?", [userId, keepToken]);
  } else {
    await db.run("DELETE FROM sessions WHERE user_id = ?", [userId]);
  }
}

/** Expired rows are only swept when their own token is presented, so do it in bulk too. */
export async function sweepExpiredSessions(): Promise<number> {
  const { rowsAffected } = await db.run("DELETE FROM sessions WHERE expires_at <= datetime('now')");
  return rowsAffected;
}

/* ---------------------------------------------------------- password reset */

/**
 * Two ways back into an account, for two different people.
 *
 * Someone with an email on file asks for a link and gets one at that address.
 * The token is 32 random bytes, good for an hour, and useless to anyone who
 * cannot read that inbox.
 *
 * A tenant with no email — plenty of them, and nobody should be locked out of
 * reporting a leak for want of one — asks their landlord, who can already see
 * everything on their property and is the person they would phone anyway. The
 * landlord gets a code short enough to read aloud. Because it is short, it is
 * only good together with the username it was issued for, it lasts a day, and
 * guesses at it are throttled like guesses at a password.
 *
 * Either way only the SHA-256 of the secret is stored, a secret works once, and
 * issuing a new one cancels any the account still had outstanding.
 */
const LINK_TTL = "+1 hour";
const CODE_TTL = "+1 day";
// Same alphabet as the invite codes: no I/O/0/1, because this gets read aloud.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const digest = (secret: string) => createHash("sha256").update(secret).digest("hex");

/** Codes are typed by hand: case, spaces and the dash in the middle do not matter. */
export const normalizeResetCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

export async function issueReset(
  userId: number,
  kind: "link" | "code",
  issuedBy: number | null = null,
): Promise<{ secret: string; expiresAt: string }> {
  const secret = kind === "link"
    ? randomBytes(32).toString("hex")
    // 8 characters of a 32-letter alphabet is 40 bits: not a password, but not
    // guessable inside a throttle that allows a handful of tries per window.
    : Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");

  await db.run("DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL", [userId]);
  const row = (await db.get<{ expires_at: string }>(
    `INSERT INTO password_resets (token_hash, user_id, kind, issued_by, expires_at)
     VALUES (?, ?, ?, ?, datetime('now', ?)) RETURNING expires_at`,
    [digest(kind === "code" ? normalizeResetCode(secret) : secret), userId, kind, issuedBy,
     kind === "link" ? LINK_TTL : CODE_TTL],
  ))!;
  return {
    secret: kind === "code" ? `${secret.slice(0, 4)}-${secret.slice(4)}` : secret,
    expiresAt: row.expires_at,
  };
}

/**
 * Spend a reset secret. Returns the reset row it matched, or null — expired,
 * used, never existed, or a code offered without its username all look the same
 * from outside.
 *
 * The UPDATE is the check: two requests racing with the same token cannot both
 * see it unused, because only one of them changes a row.
 */
export async function redeemReset(
  secret: string,
  username: string | null,
): Promise<{ user_id: number; kind: "link" | "code"; issued_by: number | null } | null> {
  const trimmed = secret.trim();
  if (!trimmed) return null;
  // A link token is 64 hex characters; anything else is treated as a code.
  const isLink = /^[0-9a-f]{64}$/i.test(trimmed);
  const hash = digest(isLink ? trimmed.toLowerCase() : normalizeResetCode(trimmed));

  const row = await db.get<{ user_id: number; kind: "link" | "code"; issued_by: number | null; username: string }>(
    `SELECT r.user_id, r.kind, r.issued_by, u.username
       FROM password_resets r JOIN users u ON u.id = r.user_id
      WHERE r.token_hash = ? AND r.used_at IS NULL AND r.expires_at > datetime('now')`,
    [hash],
  );
  if (!row) return null;
  if (row.kind === "code" && (!username || username.toLowerCase() !== row.username.toLowerCase())) {
    return null;
  }
  const { rowsAffected } = await db.run(
    "UPDATE password_resets SET used_at = datetime('now') WHERE token_hash = ? AND used_at IS NULL",
    [hash],
  );
  if (!rowsAffected) return null;
  // Anything else still outstanding for this account is now moot.
  await db.run("DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL", [row.user_id]);
  return { user_id: row.user_id, kind: row.kind, issued_by: row.issued_by };
}

/* -------------------------------------------------------------- throttling */

const MAX_ATTEMPTS = 8;
const WINDOW = "+15 minutes";

export async function loginBlocked(username: string): Promise<boolean> {
  const row = await db.get(
    `SELECT 1 AS blocked FROM login_attempts
     WHERE username = ? AND count >= ? AND reset_at > datetime('now')`,
    [username, MAX_ATTEMPTS],
  );
  return row !== null;
}

export async function noteFailedLogin(username: string): Promise<void> {
  // One statement so two simultaneous wrong guesses cannot both read "0" and
  // each write "1". An expired window resets the counter rather than extending it.
  await db.run(
    `INSERT INTO login_attempts (username, count, reset_at)
     VALUES (?, 1, datetime('now', '${WINDOW}'))
     ON CONFLICT (username) DO UPDATE SET
       count = CASE WHEN login_attempts.reset_at > datetime('now')
                    THEN login_attempts.count + 1 ELSE 1 END,
       reset_at = CASE WHEN login_attempts.reset_at > datetime('now')
                       THEN login_attempts.reset_at ELSE datetime('now', '${WINDOW}') END`,
    [username],
  );
}

export async function clearLoginAttempts(username: string): Promise<void> {
  await db.run("DELETE FROM login_attempts WHERE username = ?", [username]);
}

/* ---------------------------------------------------------------- cookies */

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

/** Resolve the logged-in user, sweeping the session if it has expired. */
export async function currentUser(req: Request): Promise<User | null> {
  const token = currentToken(req);
  if (!token) return null;
  const row = await db.get<User>(
    `SELECT u.* FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > datetime('now')`,
    [token],
  );
  if (!row) {
    await destroySession(token);
    return null;
  }
  return row;
}

export function sessionCookie(req: Request, token: string): string {
  const https =
    new URL(req.url).protocol === "https:" ||
    req.headers.get("x-forwarded-proto") === "https";
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  return [
    `${COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
    https ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export function clearCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/**
 * The session token, from either transport.
 *
 * Same-origin clients send an httpOnly cookie, which JavaScript cannot read and
 * so cannot leak. A front end on a different origin — GitHub Pages talking to
 * the API on Vercel — cannot use that cookie at all: it is third-party, so
 * Safari drops it outright and Chrome is heading the same way. Those clients
 * send the same token as a bearer header instead.
 */
export function currentToken(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice(7).trim();
    if (token) return token;
  }
  return readCookie(req, COOKIE);
}
