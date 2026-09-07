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
import { dueAt, slaTier } from "./sla";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const remoteUrl = process.env.TURSO_DATABASE_URL?.trim();
const authToken = process.env.TURSO_AUTH_TOKEN?.trim();

export const isRemote = Boolean(remoteUrl);
const url = remoteUrl ?? `file:${process.env.DB_PATH ?? "data/knoknok.db"}`;

/**
 * The connection, opened on first use rather than at import.
 *
 * Both halves of opening a local database — creating its directory and opening
 * the file — throw on a read-only filesystem. A serverless deployment with no
 * TURSO_DATABASE_URL set is exactly that case, and doing this work at import
 * meant the failure took down the module and with it every route, including the
 * static page, leaving an opaque 500 everywhere for what is a configuration
 * mistake. Opening lazily keeps the failure inside a request, where it can be
 * reported as itself.
 */
let connection: ReturnType<typeof createClient> | null = null;

function client(): ReturnType<typeof createClient> {
  if (connection) return connection;
  try {
    if (!isRemote) mkdirSync(dirname(url.replace(/^file:/, "")), { recursive: true });
    connection = createClient(authToken ? { url, authToken } : { url });
    return connection;
  } catch (err) {
    if (isRemote) throw err;
    throw new Error(
      `Cannot open a local database at "${url.replace(/^file:/, "")}". On a read-only host `
      + `such as a serverless deployment, set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN to `
      + `point at a Turso database instead.`,
      { cause: err },
    );
  }
}

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
--
-- It is nullable because a vendor can hold an account before holding any work:
-- a contractor signs up first and is given codes afterwards, so there is a real
-- state where there is nothing to point at.
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('tenant','landlord','vendor')),
  display_name  TEXT NOT NULL,
  property_id   INTEGER REFERENCES properties(id),
  unit          TEXT,
  -- A landlord's portfolio-wide vendor invite: one code that covers everything
  -- they own, now and later. Null for everyone else.
  vendor_code   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Which properties a vendor may work on, one row per property code redeemed.
-- The other route in is landlord_vendors below, which covers a whole portfolio
-- at once; a vendor's access is the union of the two.
CREATE TABLE IF NOT EXISTS property_vendors (
  property_id INTEGER NOT NULL REFERENCES properties(id),
  vendor_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (property_id, vendor_id)
);

-- A vendor working for a landlord across everything they own. This is the
-- relationship a landlord actually has with their regular contractors, so it is
-- recorded against the landlord rather than copied onto each property — which
-- also means a property added next month is covered without reissuing anything.
CREATE TABLE IF NOT EXISTS landlord_vendors (
  landlord_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vendor_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (landlord_id, vendor_id)
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
  -- The response-time target this request falls under, and when it comes due.
  -- Stored rather than derived on read so the target cannot quietly change under
  -- a request that is already running — notably when the seasons turn and heat
  -- stops being a winter emergency.
  sla_tier    TEXT,
  due_at      TEXT,
  -- Set when this ticket was raised by a schedule rather than by a person.
  recurring_id INTEGER REFERENCES recurring_tasks(id),
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

-- Upkeep that comes round again — landscaping, roof checks, cleaning, a sewer
-- inspection. A schedule is a template plus a cadence; each time it comes due it
-- raises an ordinary ticket, so recurring work lands on the same list, under the
-- same response-time targets, and is worked the same way as anything else.
--
-- next_due is the authority on when that happens. It is advanced from the
-- previous due date rather than from the moment a ticket happened to be raised,
-- so a schedule that fires late does not drift later every cycle.
CREATE TABLE IF NOT EXISTS recurring_tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id   INTEGER NOT NULL REFERENCES properties(id),
  created_by    INTEGER NOT NULL REFERENCES users(id),
  title         TEXT NOT NULL,
  details       TEXT NOT NULL DEFAULT '',
  category      TEXT NOT NULL DEFAULT 'other',
  priority      TEXT NOT NULL DEFAULT 'normal',
  interval_days INTEGER NOT NULL,
  assigned_vendor_id INTEGER REFERENCES users(id),
  next_due      TEXT NOT NULL,
  last_run      TEXT,
  paused        INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
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
CREATE INDEX IF NOT EXISTS idx_landlord_vendors_vendor ON landlord_vendors(vendor_id);
CREATE INDEX IF NOT EXISTS idx_recurring_due ON recurring_tasks(property_id, paused, next_due);
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
  // A failed migration must not be cached as the answer for the rest of the
  // process — a misconfigured instance would then never recover, even once the
  // configuration was fixed.
  migration ??= (async () => {
    // PRAGMAs are a local-file concern; Turso manages both settings itself.
    if (!isRemote) {
      await client().executeMultiple("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    }
    await client().executeMultiple(SCHEMA);
    await evolve();
  })().catch((err) => {
    migration = null;
    throw err;
  });
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
    await client().execute("ALTER TABLE properties ADD COLUMN landlord_id INTEGER REFERENCES users(id)");
    // Before this column there was exactly one landlord per property, found by
    // pointing the other way — that is the owner.
    await client().execute(
      `UPDATE properties SET landlord_id = (
         SELECT u.id FROM users u
         WHERE u.property_id = properties.id AND u.role = 'landlord'
         ORDER BY u.id LIMIT 1
       ) WHERE landlord_id IS NULL`,
    );
  }

  if (!properties.has("vendor_code")) {
    await client().execute("ALTER TABLE properties ADD COLUMN vendor_code TEXT");
    // NULLs do not collide in a SQLite unique index, so this is safe to add
    // before the codes below are filled in.
    await client().execute(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_properties_vendor_code ON properties(vendor_code)",
    );
  }

  if (!(await tableColumns("tickets")).has("assigned_vendor_id")) {
    await client().execute("ALTER TABLE tickets ADD COLUMN assigned_vendor_id INTEGER REFERENCES users(id)");
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
    await client().execute("CREATE INDEX IF NOT EXISTS idx_messages_ticket ON messages(ticket_id, id)");
  }

  // Any property still without a vendor code — pre-existing ones, and any the
  // unique index above left NULL — gets one now, so a landlord always has a
  // code to hand out.
  const pending = await client().execute("SELECT id FROM properties WHERE vendor_code IS NULL");
  for (const row of pending.rows) {
    const id = (row as unknown as unknown[])[0];
    await client().execute({
      sql: "UPDATE properties SET vendor_code = ? WHERE id = ?",
      args: [await uniqueCode("vendor_code"), id as number],
    });
  }

  // A vendor may now sign up before they hold any property code, so the cursor
  // has to be allowed to be empty. SQLite cannot drop a NOT NULL in place.
  if (/property_id\s+INTEGER NOT NULL/.test(await tableDdl("users"))) {
    await rebuild(
      "users",
      `CREATE TABLE users__next (
         id            INTEGER PRIMARY KEY AUTOINCREMENT,
         username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
         password_hash TEXT NOT NULL,
         role          TEXT NOT NULL CHECK (role IN ('tenant','landlord','vendor')),
         display_name  TEXT NOT NULL,
         property_id   INTEGER REFERENCES properties(id),
         unit          TEXT,
         created_at    TEXT NOT NULL DEFAULT (datetime('now'))
       )`,
      "id, username, password_hash, role, display_name, property_id, unit, created_at",
    );
  }

  // A landlord's portfolio-wide vendor code.
  if (!(await tableColumns("users")).has("vendor_code")) {
    await client().execute("ALTER TABLE users ADD COLUMN vendor_code TEXT");
  }
  await client().execute(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_vendor_code ON users(vendor_code)",
  );
  const codeless = await client().execute(
    "SELECT id FROM users WHERE role = 'landlord' AND vendor_code IS NULL",
  );
  for (const row of codeless.rows) {
    await client().execute({
      sql: "UPDATE users SET vendor_code = ? WHERE id = ?",
      args: [await uniqueCode("portfolio_code"), (row as unknown as unknown[])[0] as number],
    });
  }

  if (!(await tableColumns("tickets")).has("recurring_id")) {
    await client().execute(
      "ALTER TABLE tickets ADD COLUMN recurring_id INTEGER REFERENCES recurring_tasks(id)");
  }

  // Response-time targets. Existing requests get one worked out from what they
  // already say, so the list is not split between tickets that have a target and
  // tickets that do not.
  const tickets = await tableColumns("tickets");
  if (!tickets.has("sla_tier")) {
    await client().execute("ALTER TABLE tickets ADD COLUMN sla_tier TEXT");
    await client().execute("ALTER TABLE tickets ADD COLUMN due_at TEXT");
  }
  const undated = await client().execute(
    "SELECT id, title, summary, category, priority, created_at FROM tickets WHERE due_at IS NULL",
  );
  const at = (row: unknown, i: number) => (row as unknown as unknown[])[i];
  for (const row of undated.rows) {
    const id = at(row, 0) as number;
    const createdAt = String(at(row, 5));
    const tier = slaTier({
      category: String(at(row, 3) ?? ""),
      priority: String(at(row, 4) ?? ""),
      text: `${at(row, 1) ?? ""} ${at(row, 2) ?? ""}`,
      at: new Date(createdAt.replace(" ", "T") + "Z"),
    });
    await client().execute({
      sql: "UPDATE tickets SET sla_tier = ?, due_at = ? WHERE id = ?",
      args: [tier, dueAt(createdAt, tier), id],
    });
  }

  // Last, because these index columns only exist once the steps above have run.
  await client().execute(
    "CREATE INDEX IF NOT EXISTS idx_properties_landlord ON properties(landlord_id)",
  );
  await client().execute(
    "CREATE INDEX IF NOT EXISTS idx_tickets_due ON tickets(property_id, status, due_at)",
  );
}

async function tableColumns(table: string): Promise<Set<string>> {
  const rs = await client().execute(`PRAGMA table_info(${table})`);
  const at = rs.columns.indexOf("name");
  return new Set(rs.rows.map((r) => String((r as unknown as unknown[])[at])));
}

/** The stored CREATE TABLE text, which is how we read a CHECK constraint back. */
async function tableDdl(table: string): Promise<string> {
  const rs = await client().execute({
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
  await client().executeMultiple(`
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
export async function uniqueCode(
  kind: "join_code" | "vendor_code" | "portfolio_code",
): Promise<string> {
  // Distinct prefixes so the three kinds are told apart at a glance, and so a
  // code of one kind can never be mistaken for — or collide with — another.
  const shape = {
    join_code: { prefix: "", from: "properties", column: "join_code" },
    vendor_code: { prefix: "V-", from: "properties", column: "vendor_code" },
    portfolio_code: { prefix: "VP-", from: "users", column: "vendor_code" },
  }[kind];

  for (let attempt = 0; attempt < 50; attempt++) {
    const code = shape.prefix + Array.from(
      { length: 6 },
      () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)],
    ).join("");
    const taken = await client().execute({
      sql: `SELECT 1 FROM ${shape.from} WHERE ${shape.column} = ?`,
      args: [code],
    });
    if (!taken.rows.length) return code;
  }
  throw new Error(`could not allocate a ${kind}`);
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
    const rs = await client().execute({ sql, args: normalize(args) });
    return rs.rows.map((row) =>
      Object.fromEntries(rs.columns.map((c, i) => [c, (row as unknown as unknown[])[i]])),
    ) as T[];
  },

  async get<T>(sql: string, args?: Args): Promise<T | null> {
    return (await db.all<T>(sql, args))[0] ?? null;
  },

  async run(sql: string, args?: Args): Promise<{ rowsAffected: number }> {
    await migrate();
    const rs = await client().execute({ sql, args: normalize(args) });
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
  /** Null only for a vendor who has not been given a property code yet. */
  property_id: number | null;
  /** A landlord's portfolio-wide vendor invite. Null for other roles. */
  vendor_code?: string | null;
  unit: string | null;
  created_at: string;
}

export type SlaTierName = "emergency" | "major" | "standard";

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
  recurring_id: number | null;
  sla_tier: SlaTierName | null;
  due_at: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  /** Present on rows fetched through visibleTicket / listTickets. */
  tenant_name?: string | null;
  tenant_unit?: string | null;
  creator_name?: string | null;
  creator_role?: Role | null;
  vendor_name?: string | null;
  recurring_title?: string | null;
  recurring_days?: number | null;
}

export interface RecurringTask {
  id: number;
  property_id: number;
  created_by: number;
  title: string;
  details: string;
  category: string;
  priority: Priority;
  interval_days: number;
  assigned_vendor_id: number | null;
  next_due: string;
  last_run: string | null;
  paused: number;
  created_at: string;
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
