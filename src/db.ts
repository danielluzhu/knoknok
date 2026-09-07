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
-- A landlord owns many properties (landlord_id), and each property carries two
-- separate invite codes: join_code lets tenants in, vendor_code lets contractors
-- in. They are distinct so handing a plumber access never hands them the code
-- that would let them sign up as a resident.
CREATE TABLE IF NOT EXISTS properties (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  join_code   TEXT NOT NULL UNIQUE,
  vendor_code TEXT UNIQUE,
  landlord_id INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- property_id is the property this account is *currently looking at*. For a
-- tenant that is the only one they will ever have. Landlords and vendors both
-- span several, so for them it is a cursor, and the authoritative list lives in
-- properties.landlord_id / property_vendors respectively.
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('tenant','landlord','vendor')),
  display_name  TEXT NOT NULL,
  property_id   INTEGER NOT NULL REFERENCES properties(id),
  unit          TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Which properties a vendor may work on. A vendor redeems one vendor_code per
-- property, so a contractor working three buildings for the same landlord has
-- three rows and one login.
CREATE TABLE IF NOT EXISTS property_vendors (
  property_id INTEGER NOT NULL REFERENCES properties(id),
  vendor_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (property_id, vendor_id)
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
  -- The vendor who claimed this job, if any. Vendors browse every open job on a
  -- property and claim what they will do, rather than waiting to be assigned.
  assigned_vendor_id INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at   TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author     TEXT NOT NULL CHECK (author IN ('tenant','bot','landlord','vendor','system')),
  user_id    INTEGER REFERENCES users(id),
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Photos on a thread message: a tenant showing the problem rather than
-- describing it. The bytes live here rather than on disk because the API runs as
-- a serverless function with no writable filesystem, and rather than in an
-- object store because that would be another service to hold credentials for.
-- The client downscales before upload, so these are phone-photo-sized, not
-- camera-sized. ticket_id is denormalised so an access check does not need to
-- join through messages.
CREATE TABLE IF NOT EXISTS attachments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id),
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  bytes      BLOB NOT NULL,
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
-- tenant_id is the conversation key, not the sender. Vendors are not part of
-- this: they talk on the ticket thread, where the work is.
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
CREATE INDEX IF NOT EXISTS idx_property_vendors_vendor ON property_vendors(vendor_id);
CREATE INDEX IF NOT EXISTS idx_tickets_property ON tickets(property_id, status);
CREATE INDEX IF NOT EXISTS idx_tickets_tenant   ON tickets(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_messages_ticket  ON messages(ticket_id, id);
CREATE INDEX IF NOT EXISTS idx_attachments_ticket ON attachments(ticket_id, message_id);
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
 * a database created before multi-property and vendor support still has the old
 * shape. These steps bring it forward and are all no-ops once applied.
 *
 * Everything here goes through `client` rather than `db`, because `db` awaits
 * `migrate()` and would deadlock on the migration that is running.
 */
async function evolve(): Promise<void> {
  const properties = await tableColumns("properties");

  if (!properties.has("landlord_id")) {
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

  if (!properties.has("vendor_code")) {
    await client.execute("ALTER TABLE properties ADD COLUMN vendor_code TEXT");
    // NULLs do not collide in a SQLite unique index, so this is safe to add
    // before the codes below are filled in.
    await client.execute(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_properties_vendor_code ON properties(vendor_code)",
    );
  }

  if (!(await tableColumns("tickets")).has("assigned_vendor_id")) {
    await client.execute("ALTER TABLE tickets ADD COLUMN assigned_vendor_id INTEGER REFERENCES users(id)");
  }

  // A CHECK constraint cannot be altered in place — the table has to be rebuilt.
  // Both of these gained 'vendor' as an allowed value.
  if (!(await tableDdl("users")).includes("vendor")) {
    await rebuild(
      "users",
      `CREATE TABLE users__next (
         id            INTEGER PRIMARY KEY AUTOINCREMENT,
         username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
         password_hash TEXT NOT NULL,
         role          TEXT NOT NULL CHECK (role IN ('tenant','landlord','vendor')),
         display_name  TEXT NOT NULL,
         property_id   INTEGER NOT NULL REFERENCES properties(id),
         unit          TEXT,
         created_at    TEXT NOT NULL DEFAULT (datetime('now'))
       )`,
      "id, username, password_hash, role, display_name, property_id, unit, created_at",
    );
  }
  if (!(await tableDdl("messages")).includes("vendor")) {
    await rebuild(
      "messages",
      `CREATE TABLE messages__next (
         id         INTEGER PRIMARY KEY AUTOINCREMENT,
         ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
         author     TEXT NOT NULL CHECK (author IN ('tenant','bot','landlord','vendor','system')),
         user_id    INTEGER REFERENCES users(id),
         body       TEXT NOT NULL,
         created_at TEXT NOT NULL DEFAULT (datetime('now'))
       )`,
      "id, ticket_id, author, user_id, body, created_at",
    );
    await client.execute("CREATE INDEX IF NOT EXISTS idx_messages_ticket ON messages(ticket_id, id)");
  }

  // Any property still without a vendor code — pre-existing ones, and any the
  // unique index above left NULL — gets one now, so a landlord always has a
  // code to hand out.
  const pending = await client.execute("SELECT id FROM properties WHERE vendor_code IS NULL");
  for (const row of pending.rows) {
    const id = (row as unknown as unknown[])[0];
    await client.execute({
      sql: "UPDATE properties SET vendor_code = ? WHERE id = ?",
      args: [await uniqueCode("vendor_code"), id as number],
    });
  }

  // Last, because these index columns only exist once the steps above have run.
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_properties_landlord ON properties(landlord_id)",
  );
}

async function tableColumns(table: string): Promise<Set<string>> {
  const rs = await client.execute(`PRAGMA table_info(${table})`);
  const at = rs.columns.indexOf("name");
  return new Set(rs.rows.map((r) => String((r as unknown as unknown[])[at])));
}

/** The stored CREATE TABLE text, which is how we read a CHECK constraint back. */
async function tableDdl(table: string): Promise<string> {
  const rs = await client.execute({
    sql: "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
    args: [table],
  });
  return rs.rows.length ? String((rs.rows[0] as unknown as unknown[])[0] ?? "") : "";
}

/**
 * Replace a table with a new definition, carrying the rows across.
 *
 * `legacy_alter_table` matters: without it the RENAME tries to rewrite every
 * other table's references to the name being replaced, and trips over the fact
 * that the original was just dropped. With it, the other tables keep pointing at
 * the name — which, after the rename, is the new table.
 */
async function rebuild(table: string, createNext: string, columns: string): Promise<void> {
  await client.executeMultiple(`
    PRAGMA foreign_keys = OFF;
    PRAGMA legacy_alter_table = ON;
    ${createNext};
    INSERT INTO ${table}__next (${columns}) SELECT ${columns} FROM ${table};
    DROP TABLE ${table};
    ALTER TABLE ${table}__next RENAME TO ${table};
    PRAGMA legacy_alter_table = OFF;
    PRAGMA foreign_keys = ON;
  `);
}

/* ------------------------------------------------------------------ codes */

// No I/O/0/1 — these get read off a screen and typed in by hand.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * An invite code no other property is using. Vendor codes are prefixed so the
 * two kinds are told apart at a glance, and so a vendor code can never be
 * mistaken for — or collide with — a tenant one.
 */
export async function uniqueCode(column: "join_code" | "vendor_code"): Promise<string> {
  const prefix = column === "vendor_code" ? "V-" : "";
  for (let attempt = 0; attempt < 50; attempt++) {
    const code = prefix + Array.from(
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

export type Role = "tenant" | "landlord" | "vendor";
export type Status = "triage" | "open" | "closed";
export type Priority = "low" | "normal" | "high" | "urgent";

export interface Property {
  id: number;
  name: string;
  join_code: string;
  vendor_code: string | null;
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
  assigned_vendor_id: number | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  /** Present on rows fetched through visibleTicket / listTickets. */
  tenant_name?: string | null;
  tenant_unit?: string | null;
  creator_name?: string | null;
  creator_role?: Role | null;
  vendor_name?: string | null;
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
  author: "tenant" | "bot" | "landlord" | "vendor" | "system";
  user_id: number | null;
  body: string;
  created_at: string;
  author_name?: string | null;
  /** Attached photos, as ids the client fetches separately. Never the bytes. */
  photos?: { id: number; mime: string }[];
}

export interface Attachment {
  id: number;
  message_id: number;
  ticket_id: number;
  user_id: number | null;
  mime: string;
  size: number;
  bytes: Uint8Array;
  created_at: string;
}
