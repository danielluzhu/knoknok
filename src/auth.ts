/**
 * Passwords, sessions, and sign-in throttling.
 *
 * Hashing uses scrypt from node:crypto rather than Bun.password, so the same
 * code runs on Bun locally and on Node in production.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
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
  const token = readCookie(req, COOKIE);
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

export function currentToken(req: Request): string | null {
  return readCookie(req, COOKIE);
}
