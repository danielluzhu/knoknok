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
