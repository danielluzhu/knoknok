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
-- A landlord owns many properties, tracked by landlord_id. join_code is the
-- invite a tenant redeems to join one of them.
CREATE TABLE IF NOT EXISTS properties (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  join_code   TEXT NOT NULL UNIQUE,
  landlord_id INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- property_id is the property this account is *currently looking at*. For a
-- tenant that is the only one they will ever have; a landlord spans several, so
-- for them it is a cursor and properties.landlord_id is authoritative.
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

-- Direct messages between a tenant and their landlord, separate from the
-- per-request ticket threads. A property still has exactly one landlord — its
-- properties.landlord_id — so a conversation is identified by the tenant alone;
-- tenant_id is the conversation key, not the sender.
CREATE TABLE IF NOT EXISTS chat_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL REFERENCES properties(id),
  tenant_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_id   INTEGER NOT NULL REFERENCES users(id),
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chat_reads (
  tenant_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_id INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_conversation ON chat_messages(tenant_id, id);
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
    await evolve();
  })();
  return migration;
}

/* ------------------------------------------------------- schema evolution */

/**
 * `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so
 * a database created before a landlord could hold several properties still has
 * the old shape. These steps bring it forward and are no-ops once applied.
 *
 * Everything here goes through `client` rather than `db`, because `db` awaits
 * `migrate()` and would deadlock on the migration that is running.
 */
async function evolve(): Promise<void> {
  if (!(await tableColumns("properties")).has("landlord_id")) {
    await client.execute("ALTER TABLE properties ADD COLUMN landlord_id INTEGER REFERENCES users(id)");
    // Before this column there was exactly one landlord per property, found by
    // pointing the other way — that is the owner.
    await client.execute(
      `UPDATE properties SET landlord_id = (
         SELECT u.id FROM users u
         WHERE u.property_id = properties.id AND u.role = 'landlord'
         ORDER BY u.id LIMIT 1
       ) WHERE landlord_id IS NULL`,
    );
  }
  // Last, because the index column only exists once the step above has run.
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_properties_landlord ON properties(landlord_id)",
  );
}

async function tableColumns(table: string): Promise<Set<string>> {
  const rs = await client.execute(`PRAGMA table_info(${table})`);
  const at = rs.columns.indexOf("name");
  return new Set(rs.rows.map((r) => String((r as unknown as unknown[])[at])));
}

/* ------------------------------------------------------------------ codes */

// No I/O/0/1 — these get read off a screen and typed in by hand.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** An invite code no other property is using. */
export async function uniqueCode(column: "join_code"): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const code = Array.from(
      { length: 6 },
      () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)],
    ).join("");
    const taken = await client.execute({
      sql: `SELECT 1 FROM properties WHERE ${column} = ?`,
      args: [code],
    });
    if (!taken.rows.length) return code;
  }
  throw new Error(`could not allocate a ${column}`);
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

export interface Property {
  id: number;
  name: string;
  join_code: string;
  landlord_id: number | null;
  created_at: string;
}

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

export interface ChatMessage {
  id: number;
  property_id: number;
  /** Whose conversation this is — always the tenant, whoever sent the message. */
  tenant_id: number;
  sender_id: number;
  body: string;
  created_at: string;
  sender_name?: string | null;
  sender_role?: Role | null;
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
