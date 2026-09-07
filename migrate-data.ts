/**
 * Copy a local SQLite database into Turso (or any other libSQL target).
 *
 * The local file is the source of truth during development; production is a
 * Turso database. This moves what is already here into there, once, so going
 * live does not mean starting from an empty app.
 *
 *   TURSO_DATABASE_URL=libsql://... TURSO_AUTH_TOKEN=... bun run migrate-data.ts
 *
 * Safe to think about twice: it refuses to run against a target that already has
 * users unless FORCE=1 is set, so it cannot quietly double-insert or overwrite a
 * live database. Rows keep their ids, which is what makes the foreign keys, the
 * sessions and the read markers all still line up afterwards.
 */
import { createClient } from "@libsql/client";
import { migrate } from "./src/db";

const url = process.env.TURSO_DATABASE_URL?.trim();
const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
if (!url) {
  console.error("Set TURSO_DATABASE_URL (and TURSO_AUTH_TOKEN) to the target database.");
  process.exit(1);
}

const sourcePath = process.env.DB_PATH ?? "data/knoknok.db";
const source = createClient({ url: `file:${sourcePath}` });
const target = createClient(authToken ? { url, authToken } : { url });

/** Parents before children, so foreign keys always have something to point at. */
const TABLES = [
  "properties",
  "users",
  "landlord_vendors",
  "property_vendors",
  "recurring_tasks",
  "tickets",
  "messages",
  "attachments",
  "ticket_reads",
  "chat_messages",
  "chat_reads",
  "sessions",
  "login_attempts",
];

async function rows(client: ReturnType<typeof createClient>, table: string) {
  const rs = await client.execute(`SELECT * FROM ${table}`);
  return rs.rows.map((row) =>
    Object.fromEntries(rs.columns.map((c, i) => [c, (row as unknown as unknown[])[i]])),
  ) as Record<string, unknown>[];
}

// Create the schema on the target first — same code path the app uses, so there
// is no second definition of the tables to keep in step.
process.env.TURSO_DATABASE_URL = url;
await migrate();

const existing = await target.execute("SELECT COUNT(*) AS n FROM users");
const already = Number((existing.rows[0] as unknown as unknown[])[0] ?? 0);
if (already > 0 && process.env.FORCE !== "1") {
  console.error(
    `Target already has ${already} user(s). Refusing to copy into a database that is `
    + `in use.\nSet FORCE=1 if you are certain, or point at an empty database.`,
  );
  process.exit(1);
}

/**
 * Foreign keys are checked at the end rather than during.
 *
 * properties.landlord_id and users.property_id point at each other, so there is
 * no table order that satisfies both while the copy is half done. The integrity
 * that matters is the integrity of the result, which is verified below.
 */
try {
  await target.execute("PRAGMA foreign_keys = OFF");
} catch {
  // Turso manages this itself and does not accept the pragma; its default is off.
}

let total = 0;
for (const table of TABLES) {
  const data = await rows(source, table);
  if (!data.length) {
    console.log(`  ${table.padEnd(18)} empty`);
    continue;
  }
  const columns = Object.keys(data[0]!);
  const sql = `INSERT OR REPLACE INTO ${table} (${columns.join(", ")}) `
    + `VALUES (${columns.map(() => "?").join(", ")})`;

  // One batch per table: libSQL runs it as a transaction, so a table either
  // arrives whole or not at all.
  await target.batch(
    data.map((row) => ({ sql, args: columns.map((c) => row[c] as never) })),
    "write",
  );
  console.log(`  ${table.padEnd(18)} ${data.length}`);
  total += data.length;
}

// Now that everything is present, the references must all resolve.
const broken = await target.execute("PRAGMA foreign_key_check");
if (broken.rows.length) {
  console.error(`\n${broken.rows.length} broken reference(s) after copying — the target is `
    + `not consistent. Nothing was deleted; investigate before pointing the app at it.`);
  process.exit(1);
}
try {
  await target.execute("PRAGMA foreign_keys = ON");
} catch { /* as above */ }

// Counts on both sides, so "it said it worked" is not the only evidence.
console.log("\nVerifying:");
let mismatch = false;
for (const table of TABLES) {
  const [a, b] = await Promise.all([
    source.execute(`SELECT COUNT(*) AS n FROM ${table}`),
    target.execute(`SELECT COUNT(*) AS n FROM ${table}`),
  ]);
  const from = Number((a.rows[0] as unknown as unknown[])[0]);
  const to = Number((b.rows[0] as unknown as unknown[])[0]);
  if (from !== to) {
    mismatch = true;
    console.error(`  ${table.padEnd(18)} ${from} here, ${to} there — MISMATCH`);
  }
}
if (mismatch) process.exit(1);
console.log("  every table matches, and every reference resolves.");

console.log(`\nCopied ${total} rows from ${sourcePath} into ${url}.`);
