import { randomBytes } from "node:crypto";
import { db, type User } from "./db";

const SESSION_DAYS = 30;
const COOKIE = "knoknok_session";

export async function hashPassword(plain: string): Promise<string> {
  return Bun.password.hash(plain); // argon2id
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(plain, hash);
  } catch {
    return false;
  }
}

export function createSession(userId: number): string {
  const token = randomBytes(32).toString("hex");
  db.query(
    `INSERT INTO sessions (token, user_id, expires_at)
     VALUES (?, ?, datetime('now', '+${SESSION_DAYS} days'))`,
  ).run(token, userId);
  return token;
}

export function destroySession(token: string): void {
  db.query("DELETE FROM sessions WHERE token = ?").run(token);
}

/** Sign this user out everywhere except the session they are using right now. */
export function dropOtherSessions(userId: number, keepToken: string | null): void {
  if (keepToken) {
    db.query("DELETE FROM sessions WHERE user_id = ? AND token != ?").run(userId, keepToken);
  } else {
    db.query("DELETE FROM sessions WHERE user_id = ?").run(userId);
  }
}

/** Expired rows are only swept when their own token is presented, so do it in bulk too. */
export function sweepExpiredSessions(): number {
  return db.query("DELETE FROM sessions WHERE expires_at <= datetime('now')").run().changes;
}

/**
 * Failed-login throttle. In-memory on purpose: a restart clearing it is fine,
 * and it avoids a write to the users table on every wrong password.
 */
const attempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 15 * 60 * 1000;

export function loginBlocked(key: string): boolean {
  const rec = attempts.get(key);
  if (!rec) return false;
  if (Date.now() > rec.resetAt) {
    attempts.delete(key);
    return false;
  }
  return rec.count >= MAX_ATTEMPTS;
}

export function noteFailedLogin(key: string): void {
  const rec = attempts.get(key);
  if (!rec || Date.now() > rec.resetAt) {
    attempts.set(key, { count: 1, resetAt: Date.now() + WINDOW_MS });
    return;
  }
  rec.count += 1;
}

export function clearLoginAttempts(key: string): void {
  attempts.delete(key);
}

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
export function currentUser(req: Request): User | null {
  const token = readCookie(req, COOKIE);
  if (!token) return null;
  const row = db
    .query<User & { expires_at: string }, [string]>(
      `SELECT u.* FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > datetime('now')`,
    )
    .get(token);
  if (!row) {
    destroySession(token);
    return null;
  }
  return row as User;
}

export function sessionCookie(req: Request, token: string): string {
  const https = new URL(req.url).protocol === "https:" ||
    req.headers.get("x-forwarded-proto") === "https";
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  return [
    `${COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
    https ? "Secure" : "",
  ].filter(Boolean).join("; ");
}

export function clearCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function currentToken(req: Request): string | null {
  return readCookie(req, COOKIE);
}
