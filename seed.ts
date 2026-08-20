/**
 * Demo data: one property, one landlord, two tenants, and a few tickets in
 * different states. Run with `bun run seed` — it refuses to touch an existing DB.
 */
import { db } from "./src/db";
import { hashPassword } from "./src/auth";

const existing = db.query("SELECT COUNT(*) AS n FROM users").get() as { n: number };
if (existing.n > 0) {
  console.log("Database already has users — not seeding. Delete data/knoknok.db to reset.");
  process.exit(0);
}

const property = db
  .query("INSERT INTO properties (name, join_code) VALUES (?, ?) RETURNING id")
  .get("Maple Court Apartments", "MAPLE1") as { id: number };

async function user(username: string, role: "tenant" | "landlord", name: string, unit: string | null) {
  return db
    .query(
      `INSERT INTO users (username, password_hash, role, display_name, property_id, unit)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(username, await hashPassword("password123"), role, name, property.id, unit) as { id: number };
}

const landlord = await user("dana", "landlord", "Dana Whitfield", null);
const jo = await user("jo", "tenant", "Jo Park", "2A");
const sam = await user("sam", "tenant", "Sam Okafor", "4B");

interface SeedTicket {
  tenant?: number;
  by: number;
  title: string;
  summary?: string;
  cat?: string;
  pri?: string;
  status?: string;
  res?: string;
  closedBy?: string;
}

function ticket(t: SeedTicket) {
  return db
    .query(
      `INSERT INTO tickets (property_id, tenant_id, created_by, title, summary, category, priority, status, resolution, closed_by)
       VALUES ($p, $tenant, $by, $title, $summary, $cat, $pri, $status, $res, $closedBy) RETURNING id`,
    )
    .get({
      $p: property.id, $tenant: t.tenant ?? null, $by: t.by, $title: t.title,
      $summary: t.summary ?? t.title, $cat: t.cat ?? "other", $pri: t.pri ?? "normal",
      $status: t.status ?? "open", $res: t.res ?? null, $closedBy: t.closedBy ?? null,
    }) as { id: number };
}

function msg(ticketId: number, author: string, body: string, userId: number | null = null) {
  db.query("INSERT INTO messages (ticket_id, author, user_id, body) VALUES (?, ?, ?, ?)")
    .run(ticketId, author, userId, body);
}

const leak = ticket({
  tenant: jo.id, by: jo.id, title: "Water stain spreading on bathroom ceiling",
  summary: "Growing water stain on 2A bathroom ceiling, unit above may be leaking",
  cat: "plumbing", pri: "high",
});
msg(leak.id, "tenant", "There's a brown stain on my bathroom ceiling and it's noticeably bigger than last week. It feels damp.", jo.id);
msg(leak.id, "bot", "That's coming from above rather than anything you can reach, so I'm not going to have you poke at it. Is it dripping, or just damp to the touch?");
msg(leak.id, "tenant", "Just damp, no drips yet.", jo.id);
msg(leak.id, "bot", "Understood — this needs your landlord, since it likely means a leak in the unit above. I've put it on their list as high priority with the details.");
msg(leak.id, "system", "Sent to the landlord's to-do list.");

const disposal = ticket({
  tenant: sam.id, by: sam.id, title: "Garbage disposal stopped working",
  summary: "Garbage disposal — resolved by tenant during triage", cat: "plumbing",
  status: "closed", res: "Resolved during triage — no maintenance visit needed.", closedBy: "bot",
});
msg(disposal.id, "tenant", "My garbage disposal is completely dead. No sound at all when I flip the switch.", sam.id);
msg(disposal.id, "bot", "Most disposals just trip a breaker inside the unit. Turn the switch off, then reach under the sink and press the small red reset button on the bottom of the disposal. Switch it back on. Does it hum when you flip the switch, or is it completely silent?");
msg(disposal.id, "tenant", "That worked! Thank you.", sam.id);
msg(disposal.id, "bot", "Great — I'll close this one out. If it comes back, reopen this request and I'll pass it straight to your landlord with everything we tried here.");
msg(disposal.id, "system", "Closed without needing maintenance.");
db.query("UPDATE tickets SET closed_at = datetime('now') WHERE id = ?").run(disposal.id);

const gutters = ticket({
  by: landlord.id, title: "Clear gutters before the autumn rain",
  summary: "Annual gutter clearing, all three buildings", cat: "structural", pri: "normal",
});
msg(gutters.id, "landlord", "Book the usual contractor for all three buildings.", landlord.id);

const hall = ticket({
  by: landlord.id, title: "Replace burnt-out hallway light on 3rd floor",
  summary: "3rd floor hallway light out", cat: "common_area", pri: "low",
});

console.log(`Seeded "Maple Court Apartments" (join code MAPLE1).

  Landlord   dana / password123
  Tenant     jo   / password123   (unit 2A)
  Tenant     sam  / password123   (unit 4B)
`);
