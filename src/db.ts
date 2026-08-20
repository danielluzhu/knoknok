import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DB_PATH = process.env.DB_PATH ?? "data/knoknok.db";
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH, { create: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
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

CREATE INDEX IF NOT EXISTS idx_tickets_property ON tickets(property_id, status);
CREATE INDEX IF NOT EXISTS idx_tickets_tenant   ON tickets(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_messages_ticket  ON messages(ticket_id, id);
CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
`);

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
}

export interface Message {
  id: number;
  ticket_id: number;
  author: "tenant" | "bot" | "landlord" | "system";
  user_id: number | null;
  body: string;
  created_at: string;
}
