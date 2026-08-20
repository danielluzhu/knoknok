/**
 * Data layer, on libSQL.
 *
 * One driver covers both environments: a local `file:` database for development
 * and tests, and a Turso database in production. The SQL is identical either
 * way — libSQL is SQLite — so nothing here is written twice.
 *
 *   local        DB_PATH=data/knoknok.db          (default)
 *   production   TURSO_DATABASE_URL + TURSO_AUTH_TOKEN
 */
import { createClient } from "@libsql/client";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const remoteUrl = process.env.TURSO_DATABASE_URL?.trim();
const authToken = process.env.TURSO_AUTH_TOKEN?.trim();

export const isRemote = Boolean(remoteUrl);
const url = remoteUrl ?? `file:${process.env.DB_PATH ?? "data/knoknok.db"}`;

if (!isRemote) {
  // A file: URL needs its directory to exist; a Turso URL does not.
  mkdirSync(dirname(url.replace(/^file:/, "")), { recursive: true });
}

export const client = createClient(authToken ? { url, authToken } : { url });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS properties (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  join_code   TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('tenant','landlord')),
  display_name  TEXT NOT NULL,
  property_id   INTEGER NOT NULL REFERENCES properties(id),
  unit          TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

-- Failed sign-in attempts. In the database rather than in memory because on
-- serverless there is no single process to hold a counter — two requests can
-- land on two instances, and a per-instance map would not stop anyone.
CREATE TABLE IF NOT EXISTS login_attempts (
  username   TEXT PRIMARY KEY,
  count      INTEGER NOT NULL DEFAULT 0,
  reset_at   TEXT NOT NULL
);

-- A ticket is both a maintenance request and a landlord to-do item.
--   status 'triage' : tenant is still working through it with the bot
--   status 'open'   : on the landlord's to-do list
--   status 'closed' : done (by the bot's self-help, the landlord, or the tenant)
CREATE TABLE IF NOT EXISTS tickets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL REFERENCES properties(id),
  tenant_id   INTEGER REFERENCES users(id),
  created_by  INTEGER NOT NULL REFERENCES users(id),
  title       TEXT NOT NULL,
  summary     TEXT NOT NULL DEFAULT '',
  category    TEXT NOT NULL DEFAULT 'other',
  priority    TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  status      TEXT NOT NULL DEFAULT 'triage' CHECK (status IN ('triage','open','closed')),
  resolution  TEXT,
  closed_by   TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at   TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author     TEXT NOT NULL CHECK (author IN ('tenant','bot','landlord','system')),
  user_id    INTEGER REFERENCES users(id),
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- How far each person has read in each thread, so both sides can see what is new.
CREATE TABLE IF NOT EXISTS ticket_reads (
  ticket_id       INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_id    INTEGER NOT NULL DEFAULT 0,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (ticket_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_tickets_property ON tickets(property_id, status);
CREATE INDEX IF NOT EXISTS idx_tickets_tenant   ON tickets(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_messages_ticket  ON messages(ticket_id, id);
CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
`;

/**
 * Applied once per process. `CREATE TABLE IF NOT EXISTS` is idempotent, so a
 * cold start on a database that already exists costs one round trip and
 * changes nothing.
 */
let migration: Promise<void> | null = null;
export function migrate(): Promise<void> {
  migration ??= (async () => {
    // PRAGMAs are a local-file concern; Turso manages both settings itself.
    if (!isRemote) {
      await client.executeMultiple("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    }
    await client.executeMultiple(SCHEMA);
  })();
  return migration;
}

export type Args = Record<string, unknown> | unknown[];

/**
 * bun:sqlite accepted `$name` keys; libSQL wants them bare. Accept either so
 * query call sites can keep reading the way the SQL does.
 */
function normalize(args?: Args) {
  if (!args) return [];
  if (Array.isArray(args)) return args as never;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) out[k.replace(/^[$:@]/, "")] = v;
  return out as never;
}

/**
 * libSQL rows are array-like — they carry numeric indices and `length`
 * alongside the column names, which would leak into any JSON response. Rebuild
 * them as plain objects keyed only by column name.
 */
export const db = {
  async all<T>(sql: string, args?: Args): Promise<T[]> {
    await migrate();
    const rs = await client.execute({ sql, args: normalize(args) });
    return rs.rows.map((row) =>
      Object.fromEntries(rs.columns.map((c, i) => [c, (row as unknown as unknown[])[i]])),
    ) as T[];
  },

  async get<T>(sql: string, args?: Args): Promise<T | null> {
    return (await db.all<T>(sql, args))[0] ?? null;
  },

  async run(sql: string, args?: Args): Promise<{ rowsAffected: number }> {
    await migrate();
    const rs = await client.execute({ sql, args: normalize(args) });
    return { rowsAffected: rs.rowsAffected };
  },
};

export type Role = "tenant" | "landlord";
export type Status = "triage" | "open" | "closed";
export type Priority = "low" | "normal" | "high" | "urgent";

export interface User {
  id: number;
  username: string;
  password_hash: string;
  role: Role;
  display_name: string;
  property_id: number;
  unit: string | null;
  created_at: string;
}

export interface Ticket {
  id: number;
  property_id: number;
  tenant_id: number | null;
  created_by: number;
  title: string;
  summary: string;
  category: string;
  priority: Priority;
  status: Status;
  resolution: string | null;
  closed_by: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  /** Present on rows fetched through visibleTicket / listTickets. */
  tenant_name?: string | null;
  tenant_unit?: string | null;
  creator_name?: string | null;
  creator_role?: Role | null;
}

export interface TicketRead {
  ticket_id: number;
  user_id: number;
  last_read_id: number;
  updated_at: string;
}

export interface Message {
  id: number;
  ticket_id: number;
  author: "tenant" | "bot" | "landlord" | "system";
  user_id: number | null;
  body: string;
  created_at: string;
  author_name?: string | null;
}
