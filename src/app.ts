/**
 * The whole HTTP API, as one function from Request to Response.
 *
 * Nothing in here knows how it is being served. `server.ts` at the project root wraps
 * it in a node:http listener, which is what both `bun start` and Vercel run.
 * Keep it that way — anything runtime-specific belongs in that file.
 */
import {
  clearCookie,
  clearLoginAttempts,
  createSession,
  currentToken,
  currentUser,
  destroySession,
  dropOtherSessions,
  hashPassword,
  loginBlocked,
  noteFailedLogin,
  sessionCookie,
  sweepExpiredSessions,
  verifyPassword,
} from "./auth";
import {
  db, uniqueCode,
  type ChatMessage, type Message, type RecurringTask, type Ticket, type User,
} from "./db";
import { triage, usingClaude } from "./bot";
import {
  EMERGENCY_CONTACT, findIssue, intakeForClient, intakeMessage, intakeTitle, isStatutoryIssue,
  parseIntake, type Intake,
} from "./intake";
import { dueAt, isStatutoryEmergency, slaTier, SLA_LABEL, SLA_POLICY } from "./sla";

/* --------------------------------------------------------------- helpers */

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const fail = (message: string, status = 400) => json({ error: message }, status);

/**
 * Cross-origin access, for a front end hosted somewhere other than the API —
 * GitHub Pages, say. Set ALLOWED_ORIGINS to a comma-separated list of exact
 * origins; anything not listed gets no CORS headers and so is refused by the
 * browser. Unset means same-origin only, which needs no headers at all.
 */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((o) => o.trim().replace(/\/$/, ""))
  .filter(Boolean);

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
    "access-control-max-age": "86400",
    // The response differs per origin, so it must not be cached across them.
    vary: "Origin",
  };
}

function withCors(res: Response, cors: Record<string, string>): Response {
  if (!Object.keys(cors).length) return res;
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(cors)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

const CATEGORIES = new Set([
  "plumbing", "electrical", "hvac", "appliance", "pest",
  "structural", "locks_security", "common_area",
  "landscaping", "roofing", "cleaning", "sewer", "other",
]);
const PRIORITIES = new Set(["low", "normal", "high", "urgent"]);

/* ----------------------------------------------------------- schedules */

/**
 * Cadences offered in the UI. Free-form day counts are accepted too — these are
 * the ones worth a click, and the shapes upkeep actually comes in.
 */
const CADENCES = [
  { days: 7, label: "Weekly" },
  { days: 14, label: "Every 2 weeks" },
  { days: 30, label: "Monthly" },
  { days: 90, label: "Quarterly" },
  { days: 182, label: "Twice a year" },
  { days: 365, label: "Yearly" },
];

/**
 * Starting points for the upkeep most buildings need, so setting a property up
 * is a few clicks rather than a blank form. Nothing is created from these until
 * the landlord picks one.
 */
const SCHEDULE_SUGGESTIONS = [
  { title: "Landscaping", category: "landscaping", interval_days: 30,
    details: "Mow, edge, prune and clear the grounds." },
  { title: "General cleaning", category: "cleaning", interval_days: 30,
    details: "Communal areas: stairs, halls, entrance, bin store." },
  { title: "Roof inspection", category: "roofing", interval_days: 182,
    details: "Check flashing, gutters, and for slipped or missing tiles." },
  { title: "Sewer health check", category: "sewer", interval_days: 365,
    details: "Camera survey of the main line; clear roots and build-up." },
];

const MAX_INTERVAL_DAYS = 3650;

/** Midnight-anchored day arithmetic on the SQLite timestamp shape. */
function addDays(from: string | Date, days: number): string {
  const base = from instanceof Date ? from : new Date(String(from).replace(" ", "T") + "Z");
  const at = Number.isNaN(base.getTime()) ? new Date() : base;
  return new Date(at.getTime() + days * 86400_000).toISOString().replace("T", " ").slice(0, 19);
}

/**
 * Raise tickets for any schedule that has come due on these properties.
 *
 * There is no cron: the API runs as a serverless function, so this is called on
 * the way into the paths that would show the result. It is a single indexed
 * SELECT when nothing is due, which is almost always.
 *
 * A schedule that is overdue by several cycles produces one ticket, not a
 * backlog — nobody wants eleven months of missed landscaping appearing at once —
 * but the next due date is stepped forward from the schedule rather than from
 * now, so the cadence stays on its original footing.
 */
async function runDueSchedules(scope: number[]): Promise<number> {
  if (!scope.length) return 0;
  const holes = scope.map(() => "?").join(",");
  const due = await db.all<RecurringTask>(
    `SELECT * FROM recurring_tasks
     WHERE property_id IN (${holes}) AND paused = 0 AND next_due <= datetime('now')`,
    scope,
  );

  for (const task of due) {
    const ticket = (await db.get<Ticket>(
      `INSERT INTO tickets
         (property_id, tenant_id, created_by, title, summary, category, priority,
          status, assigned_vendor_id, recurring_id)
       VALUES (?, NULL, ?, ?, ?, ?, ?, 'open', ?, ?) RETURNING *`,
      [task.property_id, task.created_by, task.title, task.details || task.title,
       task.category, task.priority, task.assigned_vendor_id, task.id],
    ))!;

    await addMessage(ticket.id, "system", `Raised by the "${task.title}" schedule.`);
    if (task.details) await addMessage(ticket.id, "landlord", task.details, task.created_by);
    await applySla(ticket.id);

    // Step forward from the schedule's own clock, catching up past cycles
    // without raising a ticket for each.
    let next = addDays(task.next_due, task.interval_days);
    const now = Date.now();
    while (new Date(next.replace(" ", "T") + "Z").getTime() <= now) {
      next = addDays(next, task.interval_days);
    }
    await db.run(
      "UPDATE recurring_tasks SET next_due = ?, last_run = datetime('now') WHERE id = ?",
      [next, task.id],
    );
  }
  return due.length;
}

async function listSchedules(user: User, url: URL): Promise<Response> {
  if (user.role !== "landlord") return fail("Landlords only.", 403);
  const scope = await requestedScope(user, url);
  if (!scope) return fail("That property is not yours.", 403);
  if (!scope.length) {
    return json({ schedules: [], cadences: CADENCES, suggestions: SCHEDULE_SUGGESTIONS });
  }
  await runDueSchedules(scope);

  const holes = scope.map(() => "?").join(",");
  const schedules = await db.all(
    `SELECT r.*, p.name AS property_name, v.display_name AS vendor_name,
            (SELECT COUNT(*) FROM tickets t
              WHERE t.recurring_id = r.id AND t.status != 'closed') AS open_now
     FROM recurring_tasks r
     JOIN properties p ON p.id = r.property_id
     LEFT JOIN users v ON v.id = r.assigned_vendor_id
     WHERE r.property_id IN (${holes})
     ORDER BY r.paused, r.next_due`,
    scope,
  );
  return json({ schedules, cadences: CADENCES, suggestions: SCHEDULE_SUGGESTIONS });
}

async function createSchedule(user: User, req: Request): Promise<Response> {
  if (user.role !== "landlord") return fail("Landlords only.", 403);
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;

  const title = String(b?.title ?? "").trim();
  if (!title) return fail("Give the schedule a name.");

  const days = Math.round(Number(b?.intervalDays));
  if (!Number.isFinite(days) || days < 1 || days > MAX_INTERVAL_DAYS) {
    return fail("How often should this happen? Pick between 1 and 3650 days.");
  }

  const owned = await accessibleProperties(user);
  const propertyId = b?.propertyId ? Number(b.propertyId) : user.property_id;
  if (!propertyId || !owned.includes(propertyId)) {
    return fail("That property is not yours.", 403);
  }

  const category = CATEGORIES.has(String(b?.category)) ? String(b?.category) : "other";
  const priority = PRIORITIES.has(String(b?.priority)) ? String(b?.priority) : "normal";

  let vendorId: number | null = null;
  if (b?.vendorId) {
    const network = await networkVendors(user, owned);
    const vendor = network.find((v) => v.id === Number(b.vendorId));
    if (!vendor) return fail("That vendor is not in your network.");
    vendorId = vendor.id;
  }

  // "Starts today" means the first ticket appears now; otherwise the first one
  // is a full cycle away.
  const startNow = b?.startNow !== false;
  const nextDue = startNow
    ? new Date().toISOString().replace("T", " ").slice(0, 19)
    : addDays(new Date(), days);

  await db.run(
    `INSERT INTO recurring_tasks
       (property_id, created_by, title, details, category, priority, interval_days,
        assigned_vendor_id, next_due)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [propertyId, user.id, title, String(b?.details ?? "").trim(), category, priority,
     days, vendorId, nextDue],
  );
  await runDueSchedules([propertyId]);
  return await listSchedules(user, new URL(req.url));
}

async function updateSchedule(user: User, id: number, req: Request): Promise<Response> {
  if (user.role !== "landlord") return fail("Landlords only.", 403);
  const owned = await accessibleProperties(user);
  const task = await db.get<RecurringTask>("SELECT * FROM recurring_tasks WHERE id = ?", [id]);
  if (!task || !owned.includes(task.property_id)) return fail("Schedule not found.", 404);

  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (b?.paused !== undefined) {
    await db.run("UPDATE recurring_tasks SET paused = ? WHERE id = ?", [b.paused ? 1 : 0, id]);
  }
  if (b?.intervalDays !== undefined) {
    const days = Math.round(Number(b.intervalDays));
    if (!Number.isFinite(days) || days < 1 || days > MAX_INTERVAL_DAYS) {
      return fail("How often should this happen? Pick between 1 and 3650 days.");
    }
    // Re-anchor from the last run, so changing the cadence does not skip a turn.
    await db.run(
      "UPDATE recurring_tasks SET interval_days = ?, next_due = ? WHERE id = ?",
      [days, addDays(task.last_run ?? task.created_at, days), id],
    );
  }
  if (b?.vendorId !== undefined) {
    const wanted = b.vendorId === null || b.vendorId === "" ? null : Number(b.vendorId);
    if (wanted !== null) {
      const network = await networkVendors(user, owned);
      if (!network.some((v) => v.id === wanted)) return fail("That vendor is not in your network.");
    }
    await db.run("UPDATE recurring_tasks SET assigned_vendor_id = ? WHERE id = ?", [wanted, id]);
  }
  return await listSchedules(user, new URL(req.url));
}

async function deleteSchedule(user: User, id: number, req: Request): Promise<Response> {
  if (user.role !== "landlord") return fail("Landlords only.", 403);
  const owned = await accessibleProperties(user);
  const task = await db.get<RecurringTask>("SELECT * FROM recurring_tasks WHERE id = ?", [id]);
  if (!task || !owned.includes(task.property_id)) return fail("Schedule not found.", 404);

  // Tickets it already raised are real work and stay; they simply stop pointing
  // at a schedule that no longer exists.
  await db.run("UPDATE tickets SET recurring_id = NULL WHERE recurring_id = ?", [id]);
  await db.run("DELETE FROM recurring_tasks WHERE id = ?", [id]);
  return await listSchedules(user, new URL(req.url));
}

/* -------------------------------------------------------- response times */

/**
 * Work out a ticket's response-time target from what it says, and store it.
 *
 * Called when a request is raised and again whenever the landlord re-files it —
 * moving something into `appliance`, or marking it urgent, changes what it is
 * promised. The clock still runs from when the tenant reported it, so re-filing
 * corrects the target without quietly buying more time.
 */
async function applySla(ticketId: number) {
  const t = await db.get<{
    title: string; summary: string; category: string; priority: string; created_at: string;
  }>("SELECT title, summary, category, priority, created_at FROM tickets WHERE id = ?", [ticketId]);
  if (!t) return null;

  const tier = slaTier({
    category: t.category,
    priority: t.priority,
    text: `${t.title} ${t.summary}`,
    at: new Date(t.created_at.replace(" ", "T") + "Z"),
  });
  const due = dueAt(t.created_at, tier);
  await db.run("UPDATE tickets SET sla_tier = ?, due_at = ? WHERE id = ?", [tier, due, ticketId]);
  return { tier, due };
}

/** Put the target on the thread, so the tenant is told rather than left guessing. */
async function noteResponseTime(ticketId: number) {
  const row = await db.get<{ sla_tier: keyof typeof SLA_LABEL | null }>(
    "SELECT sla_tier FROM tickets WHERE id = ?", [ticketId]);
  const tier = row?.sla_tier;
  if (!tier || !SLA_LABEL[tier]) return;
  await addMessage(ticketId, "system", `Response time for this: ${SLA_LABEL[tier]}.`);
}

/* ----------------------------------------------------------------- photos */

const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_PHOTOS = 4;
// The client downscales before sending, so anything near this is either a very
// large photo or not a photo at all. Generous enough not to bite in practice.
const MAX_PHOTO_BYTES = 3 * 1024 * 1024;

/**
 * Decode one `data:image/...;base64,...` upload.
 *
 * Returns a message rather than throwing, because everything that can go wrong
 * here is the caller sending something we will not take, and they should be told
 * which thing it was.
 */
function decodePhoto(input: unknown): { mime: string; bytes: Buffer } | string {
  if (typeof input !== "string") return "That photo could not be read.";
  const match = /^data:([\w/+.-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(input.trim());
  if (!match) return "That photo could not be read.";

  const mime = match[1]!.toLowerCase();
  if (!PHOTO_TYPES.has(mime)) return "Photos need to be JPEG, PNG or WebP.";

  let bytes: Buffer;
  try {
    bytes = Buffer.from(match[2]!, "base64");
  } catch {
    return "That photo could not be read.";
  }
  if (!bytes.length) return "That photo is empty.";
  if (bytes.length > MAX_PHOTO_BYTES) return "That photo is too large.";
  return { mime, bytes };
}

/** Photos for every message on a ticket, grouped by message. */
async function photosByMessage(ticketId: number): Promise<Map<number, { id: number; mime: string }[]>> {
  const rows = await db.all<{ id: number; message_id: number; mime: string }>(
    "SELECT id, message_id, mime FROM attachments WHERE ticket_id = ? ORDER BY id",
    [ticketId],
  );
  const grouped = new Map<number, { id: number; mime: string }[]>();
  for (const r of rows) {
    const list = grouped.get(r.message_id) ?? [];
    list.push({ id: r.id, mime: r.mime });
    grouped.set(r.message_id, list);
  }
  return grouped;
}

/**
 * Pull `photos` out of a request body. Returns an error message if any of them
 * is unacceptable — all or nothing, so a post never half-succeeds.
 */
function takePhotos(b: Record<string, unknown> | null): { mime: string; bytes: Buffer }[] | string {
  const raw = b?.photos;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return "That photo could not be read.";
  if (raw.length > MAX_PHOTOS) return `Up to ${MAX_PHOTOS} photos at a time.`;

  const out: { mime: string; bytes: Buffer }[] = [];
  for (const one of raw) {
    const decoded = decodePhoto(one);
    if (typeof decoded === "string") return decoded;
    out.push(decoded);
  }
  return out;
}

/* --------------------------------------------------------------- messages */

/**
 * Post a message, optionally with photos.
 *
 * `photos` are already-decoded uploads — validation happens at the route, so a
 * rejected photo never reaches the point where half a message has been written.
 */
async function addMessage(
  ticketId: number,
  author: Message["author"],
  body: string,
  userId: number | null = null,
  photos: { mime: string; bytes: Buffer }[] = [],
) {
  const message = (await db.get<{ id: number }>(
    "INSERT INTO messages (ticket_id, author, user_id, body) VALUES (?, ?, ?, ?) RETURNING id",
    [ticketId, author, userId, body.trim()],
  ))!;
  for (const photo of photos) {
    await db.run(
      `INSERT INTO attachments (message_id, ticket_id, user_id, mime, size, bytes)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [message.id, ticketId, userId, photo.mime, photo.bytes.length, photo.bytes],
    );
  }
  await db.run("UPDATE tickets SET updated_at = datetime('now') WHERE id = ?", [ticketId]);
  return message.id;
}

async function ticketMessages(ticketId: number): Promise<Message[]> {
  const messages = await db.all<Message>(
    `SELECT m.*, u.display_name AS author_name
     FROM messages m LEFT JOIN users u ON u.id = m.user_id
     WHERE m.ticket_id = ? ORDER BY m.id`,
    [ticketId],
  );
  const photos = await photosByMessage(ticketId);
  for (const m of messages) {
    const mine = photos.get(m.id);
    if (mine) m.photos = mine;
  }
  return messages;
}

/** Remember that this user has seen everything posted in this thread so far. */
function markRead(ticketId: number, userId: number) {
  return db.run(
    `INSERT INTO ticket_reads (ticket_id, user_id, last_read_id, updated_at)
     VALUES (?, ?, (SELECT COALESCE(MAX(id), 0) FROM messages WHERE ticket_id = ?), datetime('now'))
     ON CONFLICT (ticket_id, user_id) DO UPDATE SET
       last_read_id = excluded.last_read_id, updated_at = excluded.updated_at`,
    [ticketId, userId, ticketId],
  );
}

/** The last message this user had seen in this thread. Read it before markRead. */
async function readMarker(ticketId: number, userId: number): Promise<number> {
  const row = await db.get<{ last_read_id: number }>(
    "SELECT last_read_id FROM ticket_reads WHERE ticket_id = ? AND user_id = ?",
    [ticketId, userId],
  );
  return row?.last_read_id ?? 0;
}

/**
 * Every property this account may look at. A tenant has one; a landlord has the
 * ones they own; a vendor has the ones they hold a code for. This is the set the
 * "all properties" view spans, and the set any single-property request must fall
 * inside — `users.property_id` alone is a cursor, never a permission.
 */
async function accessibleProperties(user: User): Promise<number[]> {
  // A tenant always has exactly one; a vendor may have none yet.
  if (user.role === "tenant") return user.property_id ? [user.property_id] : [];
  if (user.role === "landlord") {
    const owned = await db.all<{ id: number }>(
      "SELECT id FROM properties WHERE landlord_id = ?", [user.id]);
    return owned.map((r) => r.id);
  }
  // A vendor gets in two ways, and holding one does not cancel the other: a
  // single property they were handed a code for, or a landlord's whole
  // portfolio — including properties that landlord adds later.
  const rows = await db.all<{ id: number }>(
    `SELECT id FROM properties
     WHERE id IN (SELECT property_id FROM property_vendors WHERE vendor_id = $me)
        OR landlord_id IN (SELECT landlord_id FROM landlord_vendors WHERE vendor_id = $me)
     ORDER BY id`,
    { me: user.id },
  );
  return rows.map((r) => r.id);
}

/**
 * Which properties a request is about. `?property=all` — the default the front
 * end sends — means every one of them; a specific id narrows to that one, and is
 * refused unless it is theirs.
 */
async function requestedScope(user: User, url: URL): Promise<number[] | null> {
  const all = await accessibleProperties(user);
  const asked = url.searchParams.get("property");
  if (!asked || asked === "all") return all;
  const id = Number(asked);
  return all.includes(id) ? [id] : null;
}

/**
 * A landlord's vendor network: everyone who can see any of these properties,
 * whether through a single property code or the landlord's portfolio code.
 *
 * A vendor working three of these buildings is one person, so they are folded
 * into a single row carrying their open job count across the scope.
 */
function networkVendors(landlord: User, scope: number[]) {
  const holes = scope.map((_, i) => `$p${i}`).join(",");
  const params: Record<string, unknown> = { me: landlord.id };
  scope.forEach((id, i) => { params[`p${i}`] = id; });
  return db.all<{ id: number; display_name: string; username: string; jobs: number }>(
    `SELECT u.id, u.display_name, u.username,
            (SELECT COUNT(*) FROM tickets t
              WHERE t.assigned_vendor_id = u.id AND t.status = 'open'
                AND t.property_id IN (${holes})) AS jobs
     FROM users u
     WHERE u.role = 'vendor'
       AND (u.id IN (SELECT vendor_id FROM property_vendors WHERE property_id IN (${holes}))
         OR u.id IN (SELECT vendor_id FROM landlord_vendors WHERE landlord_id = $me))
     ORDER BY u.display_name`,
    params,
  );
}

/** Anyone a landlord may target a to-do at: a tenant on a property they own. */
async function propertyTenant(user: User, tenantId: number): Promise<User | null> {
  const scope = await accessibleProperties(user);
  if (!scope.length) return null;
  return db.get<User>(
    `SELECT * FROM users
     WHERE id = ? AND role = 'tenant' AND property_id IN (${scope.map(() => "?").join(",")})`,
    [tenantId, ...scope],
  );
}

/**
 * Tenants see only their own tickets; landlords see everything on their property.
 * The joined names ride along so the detail view can name the tenant and whoever
 * raised the task without a second round trip.
 */
async function visibleTicket(user: User, id: number): Promise<Ticket | null> {
  const t = await db.get<Ticket>(
    `SELECT t.*, u.display_name AS tenant_name, u.unit AS tenant_unit,
            c.display_name AS creator_name, c.role AS creator_role,
            v.display_name AS vendor_name, pr.name AS property_name,
            r.title AS recurring_title, r.interval_days AS recurring_days
     FROM tickets t
     LEFT JOIN users u ON u.id = t.tenant_id
     LEFT JOIN users c ON c.id = t.created_by
     LEFT JOIN users v ON v.id = t.assigned_vendor_id
     LEFT JOIN recurring_tasks r ON r.id = t.recurring_id
     JOIN properties pr ON pr.id = t.property_id
     WHERE t.id = ?`,
    [id],
  );
  if (!t) return null;
  if (!(await accessibleProperties(user)).includes(t.property_id)) return null;
  if (user.role === "tenant" && t.tenant_id !== user.id) return null;
  // Triage is the tenant working through it with the bot in private. It is not
  // work yet, and it is not a contractor's to read.
  if (user.role === "vendor" && t.status === "triage") return null;
  return t;
}

/* ------------------------------------------------------------- properties */

/**
 * A landlord runs many buildings and a vendor works across several, so
 * `users.property_id` is only ever "the one being looked at right now". These
 * two answer the real question — is this account allowed to be looking at it —
 * and every property-scoped route leans on them.
 */
function landlordOwns(userId: number, propertyId: number) {
  return db.get<{ id: number }>(
    "SELECT id FROM properties WHERE id = ? AND landlord_id = ?",
    [propertyId, userId],
  );
}

function vendorWorksOn(userId: number, propertyId: number) {
  return db.get<{ id: number }>(
    `SELECT p.id FROM properties p
     WHERE p.id = $property
       AND (EXISTS (SELECT 1 FROM property_vendors pv
                    WHERE pv.vendor_id = $me AND pv.property_id = p.id)
         OR EXISTS (SELECT 1 FROM landlord_vendors lv
                    WHERE lv.vendor_id = $me AND lv.landlord_id = p.landlord_id))`,
    { me: userId, property: propertyId },
  );
}

/** Every property this account may switch to, newest last, with a little context. */
async function propertiesFor(user: User) {
  const scope = user.role === "landlord"
    ? "p.landlord_id = $me"
    : `p.id IN (SELECT property_id FROM property_vendors WHERE vendor_id = $me)
       OR p.landlord_id IN (SELECT landlord_id FROM landlord_vendors WHERE vendor_id = $me)`;
  return await db.all(
    `SELECT p.id, p.name, p.join_code, p.vendor_code,
            (SELECT COUNT(*) FROM users u WHERE u.property_id = p.id AND u.role = 'tenant') AS tenants,
            (SELECT COUNT(*) FROM tickets t WHERE t.property_id = p.id AND t.status = 'open') AS open,
            (SELECT COUNT(*) FROM tickets t WHERE t.property_id = p.id AND t.status != 'closed'
               AND t.due_at IS NOT NULL AND t.due_at < datetime('now')) AS overdue
     FROM properties p WHERE ${scope} ORDER BY p.id`,
    { me: user.id },
  );
}

/**
 * Create a property owned by this landlord.
 *
 * Deliberately leaves the cursor alone: adding a building to the portfolio is
 * not a statement about which one you want to work on, and moving it would drag
 * the view into the empty new property.
 */
async function createProperty(landlord: User, name: string) {
  const property = (await db.get<{ id: number }>(
    `INSERT INTO properties (name, join_code, vendor_code, landlord_id)
     VALUES (?, ?, ?, ?) RETURNING id`,
    [name, await uniqueCode("join_code"), await uniqueCode("vendor_code"), landlord.id],
  ))!;
  return property.id;
}

async function publicUser(u: User) {
  const property = u.property_id
    ? await db.get<{ name: string; join_code: string; vendor_code: string | null }>(
        "SELECT name, join_code, vendor_code FROM properties WHERE id = ?",
        [u.property_id],
      )
    : null;
  const landlord = u.role === "landlord";
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    displayName: u.display_name,
    unit: u.unit,
    // Null for a vendor who has signed up but holds no property code yet.
    property: property && {
      id: u.property_id,
      name: property.name,
      // Both codes are shared secrets for the building — landlords only. They
      // are what a landlord hands to a tenant or a contractor respectively.
      joinCode: landlord ? property.join_code : undefined,
      vendorCode: landlord ? property.vendor_code : undefined,
    },
    // The portfolio-wide vendor invite. Landlords only — it is a secret that
    // opens everything they own.
    portfolioCode: landlord ? u.vendor_code ?? undefined : undefined,
    // Only the roles that can span several need the switcher drawn at all.
    propertyCount: u.role === "tenant" ? 1 : (await propertiesFor(u)).length,
    botEngine: usingClaude ? "claude" : "rules",
  };
}

/** The structured intake a ticket was raised with, if it was raised that way. */
function storedIntake(ticket: Ticket): Intake | null {
  if (!ticket.intake) return null;
  try {
    const parsed = parseIntake(JSON.parse(ticket.intake));
    return typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Run the bot over a ticket in triage and apply whatever it decided.
 * Returns the bot's own message plus any status change.
 */
async function runTriage(ticket: Ticket) {
  const history = await ticketMessages(ticket.id);
  const result = await triage(ticket.title, history, storedIntake(ticket));

  await addMessage(ticket.id, "bot", result.reply);

  if (result.action === "escalate") {
    await db.run(
      `UPDATE tickets
       SET status = 'open', category = ?, priority = ?, summary = ?, updated_at = datetime('now')
       WHERE id = ?`,
      [result.category, result.priority, result.summary, ticket.id],
    );
    await addMessage(ticket.id, "system", "Sent to the landlord's to-do list.");
  } else if (result.action === "resolved") {
    await db.run(
      `UPDATE tickets
       SET status = 'closed', category = ?, summary = ?, resolution = ?, closed_by = 'bot',
           closed_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ?`,
      [
        result.category,
        result.summary,
        "Resolved during triage — no maintenance visit needed.",
        ticket.id,
      ],
    );
    await addMessage(ticket.id, "system", "Closed without needing maintenance.");
  } else {
    await db.run(
      "UPDATE tickets SET category = ?, priority = ?, updated_at = datetime('now') WHERE id = ?",
      [result.category, result.priority, ticket.id],
    );
  }
  return result;
}

/* ---------------------------------------------------------------- routes */

async function handleSignup(req: Request): Promise<Response> {
  const b = (await req.json().catch(() => null)) as Record<string, string> | null;
  if (!b) return fail("Malformed request body.");

  const username = String(b.username ?? "").trim();
  const password = String(b.password ?? "");
  const displayName = String(b.displayName ?? "").trim();
  const role = b.role === "landlord" || b.role === "vendor" ? b.role : "tenant";

  if (!/^[A-Za-z0-9._-]{3,32}$/.test(username)) {
    return fail("Username must be 3-32 characters (letters, numbers, . _ -).");
  }
  if (password.length < 8) return fail("Password must be at least 8 characters.");
  if (!displayName) return fail("Please enter your name.");
  if (await db.get("SELECT 1 AS x FROM users WHERE username = ?", [username])) {
    return fail("That username is taken.");
  }

  // Null only for a vendor signing up before they hold any property code.
  let propertyId: number | null = null;
  let unit: string | null = null;
  // A landlord's first property cannot name its owner yet — the user row does
  // not exist until below — so the ownership is stamped on afterwards.
  let claimProperty = false;
  let joinAsVendor = false;
  let joinLandlordId: number | null = null;

  if (role === "landlord") {
    // Optional at sign-up: a landlord who has not settled on a name yet gets one
    // derived from their own, which reads fine in the header until they say more.
    const propertyName = String(b.propertyName ?? "").trim() || `${displayName}'s property`;
    const res = (await db.get<{ id: number }>(
      `INSERT INTO properties (name, join_code, vendor_code) VALUES (?, ?, ?) RETURNING id`,
      [propertyName, await uniqueCode("join_code"), await uniqueCode("vendor_code")],
    ))!;
    propertyId = res.id;
    claimProperty = true;
  } else if (role === "vendor") {
    // A code is optional here. A contractor signs up when they decide to use the
    // app, which is not the same moment a landlord gets round to sending them a
    // code — requiring one would mean the account cannot exist until the work
    // does. Without it they land in an empty state that asks for one.
    const vendorCode = String(b.vendorCode ?? "").trim().toUpperCase();
    if (vendorCode) {
      // Either kind of code works here, same as redeeming one later.
      const owner = await db.get<{ id: number }>(
        "SELECT id FROM users WHERE vendor_code = ? AND role = 'landlord'",
        [vendorCode],
      );
      if (owner) {
        joinLandlordId = owner.id;
        const first = await db.get<{ id: number }>(
          "SELECT id FROM properties WHERE landlord_id = ? ORDER BY id LIMIT 1",
          [owner.id],
        );
        propertyId = first?.id ?? null;
      } else {
        const property = await db.get<{ id: number }>(
          "SELECT id FROM properties WHERE vendor_code = ?",
          [vendorCode],
        );
        // Deliberately not "that is a tenant code" — the code spaces are
        // separate on purpose, and saying which one was typed helps nobody but
        // a guesser.
        if (!property) return fail("No property matches that vendor code.");
        propertyId = property.id;
        joinAsVendor = true;
      }
    } else {
      propertyId = null;
    }
  } else {
    const joinCode = String(b.joinCode ?? "").trim().toUpperCase();
    unit = String(b.unit ?? "").trim();
    if (!joinCode) return fail("Enter the property code your landlord gave you.");
    if (!unit) return fail("Enter your unit number.");
    const property = await db.get<{ id: number }>(
      "SELECT id FROM properties WHERE join_code = ?",
      [joinCode],
    );
    if (!property) return fail("No property matches that code.");
    propertyId = property.id;
  }

  const hash = await hashPassword(password);
  const user = (await db.get<User>(
    `INSERT INTO users (username, password_hash, role, display_name, property_id, unit)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
    [username, hash, role, displayName, propertyId, unit],
  ))!;

  if (claimProperty) {
    await db.run("UPDATE properties SET landlord_id = ? WHERE id = ?", [user.id, propertyId]);
    // One code covering everything they own, now and later — the code a landlord
    // actually wants to hand a regular contractor.
    await db.run("UPDATE users SET vendor_code = ? WHERE id = ?", [
      await uniqueCode("portfolio_code"), user.id,
    ]);
  }
  if (joinAsVendor && propertyId) {
    await db.run(
      "INSERT INTO property_vendors (property_id, vendor_id) VALUES (?, ?)",
      [propertyId, user.id],
    );
  }
  if (joinLandlordId) {
    await db.run(
      "INSERT INTO landlord_vendors (landlord_id, vendor_id) VALUES (?, ?)",
      [joinLandlordId, user.id],
    );
  }

  const token = await createSession(user.id);
  // Re-read: the steps above stamp ownership and the portfolio code onto rows
  // the `user` object above predates.
  const fresh = (await db.get<User>("SELECT * FROM users WHERE id = ?", [user.id]))!;
  return json({ user: await publicUser(fresh), token }, 200, {
    "set-cookie": sessionCookie(req, token),
  });
}

async function handleLogin(req: Request): Promise<Response> {
  const b = (await req.json().catch(() => null)) as Record<string, string> | null;
  if (!b) return fail("Malformed request body.");

  const username = String(b.username ?? "").trim();
  const throttleKey = username.toLowerCase();
  if (await loginBlocked(throttleKey)) {
    return fail("Too many failed attempts. Try again in 15 minutes.", 429);
  }

  const user = await db.get<User>("SELECT * FROM users WHERE username = ?", [username]);

  // Same message either way, so this can't be used to enumerate usernames.
  if (!user || !(await verifyPassword(String(b.password ?? ""), user.password_hash))) {
    await noteFailedLogin(throttleKey);
    return fail("Incorrect username or password.", 401);
  }

  await clearLoginAttempts(throttleKey);
  // No long-lived process on serverless to run a cleanup timer, so take the
  // opportunity here — sign-ins are rare and the delete is cheap.
  void sweepExpiredSessions().catch(() => {});
  const token = await createSession(user.id);
  // The token is also returned in the body: a cross-origin front end cannot read
  // the cookie, so it holds this and sends it as a bearer header instead.
  return json({ user: await publicUser(user), token }, 200, {
    "set-cookie": sessionCookie(req, token),
  });
}

async function listTickets(user: User, url: URL): Promise<Response> {
  const status = url.searchParams.get("status"); // open | closed | triage | all
  const scope = await requestedScope(user, url);
  if (!scope) return fail("That property is not yours.", 403);
  if (!scope.length) return json({ tickets: [] });
  // No cron on a serverless function, so due schedules are raised on the way
  // into the list that would show them.
  await runDueSchedules(scope);

  const clauses: string[] = [`t.property_id IN (${scope.map((_, i) => `$p${i}`).join(",")})`];
  const params: Record<string, unknown> = { me: user.id };
  scope.forEach((id, i) => { params[`p${i}`] = id; });

  if (user.role === "tenant") {
    clauses.push("t.tenant_id = $tenant");
    params.tenant = user.id;
  } else {
    // Triage threads are the tenant's private conversation with the bot until escalated.
    clauses.push("t.status != 'triage'");
  }
  // Vendors browse the whole open list and claim from it, so "mine" is a filter
  // over that rather than the only thing they can see.
  if (user.role === "vendor" && url.searchParams.get("assigned") === "me") {
    clauses.push("t.assigned_vendor_id = $me");
  }
  if (status && status !== "all") {
    clauses.push("t.status = $status");
    params.status = status;
  }

  const tickets = await db.all(
    `SELECT t.*, u.display_name AS tenant_name, u.unit AS tenant_unit,
            c.display_name AS creator_name, c.role AS creator_role,
            v.display_name AS vendor_name, pr.name AS property_name,
            r.title AS recurring_title, r.interval_days AS recurring_days,
            (SELECT m.body FROM messages m WHERE m.ticket_id = t.id ORDER BY m.id DESC LIMIT 1) AS last_message,
            (SELECT COUNT(*) FROM messages m
               WHERE m.ticket_id = t.id
                 AND m.author != 'system'
                 AND (m.user_id IS NULL OR m.user_id != $me)
                 AND m.id > COALESCE((SELECT r.last_read_id FROM ticket_reads r
                                      WHERE r.ticket_id = t.id AND r.user_id = $me), 0)) AS unread
     FROM tickets t
     LEFT JOIN users u ON u.id = t.tenant_id
     LEFT JOIN users c ON c.id = t.created_by
     LEFT JOIN users v ON v.id = t.assigned_vendor_id
     LEFT JOIN recurring_tasks r ON r.id = t.recurring_id
     JOIN properties pr ON pr.id = t.property_id
     WHERE ${clauses.join(" AND ")}
     ORDER BY
       CASE t.status WHEN 'open' THEN 0 WHEN 'triage' THEN 1 ELSE 2 END,
       -- Soonest due first: the point of having targets is that the list is
       -- ordered by them. Closed work falls back to recency, where a due date
       -- no longer means anything.
       CASE WHEN t.status = 'closed' THEN 1 ELSE 0 END,
       CASE WHEN t.status = 'closed' THEN NULL ELSE t.due_at END ASC,
       CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
       t.updated_at DESC`,
    params,
  );

  return json({ tickets });
}

async function createTicket(user: User, req: Request): Promise<Response> {
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  let title = String(b?.title ?? "").trim();
  let description = String(b?.description ?? "").trim();

  const photos = takePhotos(b);
  if (typeof photos === "string") return fail(photos);
  if (user.role === "vendor") {
    return fail("Vendors work the list rather than adding to it.", 403);
  }

  if (user.role === "tenant") {
    // The structured path: the tenant picked an issue and filled in the
    // basics. The title and the opening message are composed from those, so
    // every request of this shape reads the same way on the landlord's list.
    // The free-text path (title + description) still works for older clients
    // and for the API tests.
    const intake = parseIntake(b?.intake);
    if (typeof intake === "string") return fail(intake);
    if (intake) {
      title ||= intakeTitle(intake);
      description = intakeMessage(intake);
    }
    if (!title) return fail("Give the request a short title.");
    if (!description) return fail("Describe what is going on so the assistant can help.");

    const issue = intake ? findIssue(intake.issue) : null;
    const ticket = (await db.get<Ticket>(
      `INSERT INTO tickets
         (property_id, tenant_id, created_by, title, summary, category, priority, status, intake)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'triage', ?) RETURNING *`,
      [user.property_id, user.id, user.id, title, title,
       issue?.category ?? "other", issue?.priority ?? "normal",
       intake ? JSON.stringify(intake) : null],
    ))!;

    await addMessage(ticket.id, "tenant", description, user.id, photos);
    // A statutory emergency — water, electricity or heating-season heat off, or
    // something life-threatening — gets the call-out number on the thread as
    // well as in the form. The form block is gone the moment the request is
    // sent, and a number the tenant can no longer see has not been given to
    // them. Nothing else gets it: a line that rings for a stuck lock is a line
    // that goes unanswered for a gas leak.
    // A free-text request has no issue to read, so its wording is tested
    // instead — someone typing "no water in the whole unit" is owed the same
    // number as someone who picked it off the tree.
    const statutory = issue
      ? isStatutoryIssue(issue)
      : isStatutoryEmergency({ text: `${title} ${description}` });
    if (statutory) {
      await addMessage(ticket.id, "system", EMERGENCY_CONTACT);
    }
    await runTriage(ticket);
    // After triage, so the bot's category and priority feed the target.
    await applySla(ticket.id);
    // The bot escalates on its own when it cannot resolve something, so the note
    // belongs here as well as on the tenant's manual escalation.
    const after = await db.get<{ status: string }>(
      "SELECT status FROM tickets WHERE id = ?", [ticket.id]);
    if (after?.status === "open") await noteResponseTime(ticket.id);
    await markRead(ticket.id, user.id);
    return json({
      ticket: await visibleTicket(user, ticket.id),
      messages: await ticketMessages(ticket.id),
    });
  }

  // Landlords add to-dos straight to the list — no triage. A to-do can be kept
  // internal (tenant_id NULL) or raised with a specific tenant, who then sees it
  // in their own list and can talk it through in the same thread.
  if (!title) return fail("Give the request a short title.");
  const priority = PRIORITIES.has(String(b?.priority)) ? String(b?.priority) : "normal";
  const category = CATEGORIES.has(String(b?.category)) ? String(b?.category) : "other";

  // Viewing every property at once, a to-do has to say which one it is for.
  // Falling back to the cursor keeps the single-property case a no-op.
  const owned = await accessibleProperties(user);
  const propertyId = b?.propertyId ? Number(b.propertyId) : user.property_id;
  if (!propertyId || !owned.includes(propertyId)) {
    return fail("That property is not yours.", 403);
  }

  let tenantId: number | null = null;
  if (b?.tenantId) {
    const tenant = await propertyTenant(user, Number(b.tenantId));
    if (!tenant || tenant.property_id !== propertyId) {
      return fail("That tenant is not on this property.");
    }
    tenantId = tenant.id;
  }

  const ticket = (await db.get<Ticket>(
    `INSERT INTO tickets (property_id, tenant_id, created_by, title, summary, category, priority, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open') RETURNING *`,
    [propertyId, tenantId, user.id, title, description || title, category, priority],
  ))!;

  if (description || photos.length) {
    await addMessage(ticket.id, "landlord", description, user.id, photos);
  }
  if (tenantId) {
    await addMessage(ticket.id, "system", `${user.display_name} raised this with the tenant.`);
  }
  await applySla(ticket.id);
  await markRead(ticket.id, user.id);
  return json({
    ticket: await visibleTicket(user, ticket.id),
    messages: await ticketMessages(ticket.id),
  });
}

async function postMessage(user: User, ticket: Ticket, req: Request): Promise<Response> {
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const body = String(b?.body ?? "").trim();
  const photos = takePhotos(b);
  if (typeof photos === "string") return fail(photos);
  // A photo on its own says plenty — this is often the whole point of sending one.
  if (!body && !photos.length) return fail("Message is empty.");
  if (ticket.status === "closed") return fail("This request is closed. Reopen it to keep talking.");

  await addMessage(ticket.id, user.role, body, user.id, photos);

  // While a request is in triage the bot owns the conversation.
  let botResult = null;
  if (ticket.status === "triage" && user.role === "tenant") {
    botResult = await runTriage(ticket);
  }
  await markRead(ticket.id, user.id);

  return json({
    ticket: await visibleTicket(user, ticket.id),
    messages: await ticketMessages(ticket.id),
    bot: botResult,
  });
}

/**
 * The landlord owns the to-do list, so they get the final say on how a task is
 * filed — the bot's category and priority are a starting point, not a verdict.
 */
async function updateTicket(user: User, ticket: Ticket, req: Request): Promise<Response> {
  if (user.role !== "landlord") return fail("Landlords only.", 403);
  if (ticket.status === "closed") return fail("Reopen this task before editing it.");

  const b = (await req.json().catch(() => null)) as Record<string, string> | null;
  if (!b) return fail("Malformed request body.");

  const changes: string[] = [];
  const sets: string[] = [];
  const params: Record<string, unknown> = { id: ticket.id };

  if (b.title !== undefined) {
    const title = String(b.title).trim();
    if (!title) return fail("Title cannot be empty.");
    if (title !== ticket.title) {
      sets.push("title = $title");
      params.title = title;
      changes.push(`renamed it to "${title}"`);
    }
  }
  if (b.priority !== undefined && b.priority !== ticket.priority) {
    if (!PRIORITIES.has(String(b.priority))) return fail("Unknown priority.");
    sets.push("priority = $priority");
    params.priority = String(b.priority);
    changes.push(`set priority to ${b.priority}`);
  }
  if (b.category !== undefined && b.category !== ticket.category) {
    if (!CATEGORIES.has(String(b.category))) return fail("Unknown category.");
    sets.push("category = $category");
    params.category = String(b.category);
    changes.push(`filed it under ${String(b.category).replace("_", " ")}`);
  }

  if (sets.length) {
    await db.run(
      `UPDATE tickets SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = $id`,
      params,
    );
    await addMessage(ticket.id, "system", `${user.display_name} ${changes.join(" and ")}.`, user.id);

    // Re-filing can move a request between targets — say so, since the tenant is
    // reading the same thread and the promise just changed.
    const before = ticket.sla_tier;
    const after = await applySla(ticket.id);
    if (after && after.tier !== before) {
      await addMessage(
        ticket.id, "system",
        `Response time is now ${SLA_LABEL[after.tier]} of the request being raised.`,
      );
    }
  }
  return json({
    ticket: await visibleTicket(user, ticket.id),
    messages: await ticketMessages(ticket.id),
  });
}

async function escalate(user: User, ticket: Ticket): Promise<Response> {
  if (ticket.status !== "triage") return fail("This request is already with your landlord.");
  await db.run("UPDATE tickets SET status = 'open', updated_at = datetime('now') WHERE id = ?", [
    ticket.id,
  ]);
  await addMessage(ticket.id, "system", `${user.display_name} sent this to the landlord.`);
  await noteResponseTime(ticket.id);
  return json({
    ticket: await visibleTicket(user, ticket.id),
    messages: await ticketMessages(ticket.id),
  });
}

async function closeTicket(user: User, ticket: Ticket, req: Request): Promise<Response> {
  if (ticket.status === "closed") return fail("Already closed.");
  const b = (await req.json().catch(() => null)) as Record<string, string> | null;
  const resolution = String(b?.resolution ?? "").trim() || "Marked complete.";

  await db.run(
    `UPDATE tickets
     SET status = 'closed', resolution = ?, closed_by = ?, closed_at = datetime('now'),
         updated_at = datetime('now')
     WHERE id = ?`,
    [resolution, user.display_name, ticket.id],
  );
  await addMessage(ticket.id, "system", `Closed by ${user.display_name}: ${resolution}`, user.id);
  return json({
    ticket: await visibleTicket(user, ticket.id),
    messages: await ticketMessages(ticket.id),
  });
}

async function reopenTicket(user: User, ticket: Ticket): Promise<Response> {
  if (ticket.status !== "closed") return fail("This request is not closed.");
  // A tenant reopening a bot-closed thread goes back to the bot; anything else
  // goes back on the landlord's list.
  const next = ticket.closed_by === "bot" && user.role === "tenant" ? "triage" : "open";
  await db.run(
    `UPDATE tickets
     SET status = ?, resolution = NULL, closed_by = NULL, closed_at = NULL,
         updated_at = datetime('now')
     WHERE id = ?`,
    [next, ticket.id],
  );
  await addMessage(ticket.id, "system", `Reopened by ${user.display_name}.`, user.id);
  return json({
    ticket: await visibleTicket(user, ticket.id),
    messages: await ticketMessages(ticket.id),
  });
}

/**
 * Claim a job, or put it back. Vendors see every open job on the property and
 * take what they will do, so this is the whole assignment mechanism — a landlord
 * never has to hand work out one piece at a time.
 */
async function claimTicket(user: User, ticket: Ticket, claim: boolean): Promise<Response> {
  if (user.role !== "vendor") return fail("Vendors only.", 403);
  if (ticket.status !== "open") return fail("Only open jobs can be picked up.");

  if (claim) {
    if (ticket.assigned_vendor_id === user.id) return fail("You already have this one.");
    if (ticket.assigned_vendor_id) return fail("Another vendor already has this one.", 409);
  } else if (ticket.assigned_vendor_id !== user.id) {
    return fail("This is not yours to release.", 403);
  }

  // The WHERE guards against two vendors claiming the same job at once: the
  // second UPDATE matches nothing, and we say so rather than silently stealing it.
  const res = await db.run(
    `UPDATE tickets SET assigned_vendor_id = ?, updated_at = datetime('now')
     WHERE id = ? AND assigned_vendor_id IS ?`,
    [claim ? user.id : null, ticket.id, claim ? null : user.id],
  );
  if (!res.rowsAffected) return fail("Another vendor already has this one.", 409);

  await addMessage(
    ticket.id,
    "system",
    claim ? `${user.display_name} picked this up.` : `${user.display_name} released this.`,
    user.id,
  );
  return json({
    ticket: await visibleTicket(user, ticket.id),
    messages: await ticketMessages(ticket.id),
  });
}

/**
 * A landlord hands a job to one of their vendors, or takes it back.
 *
 * This sits alongside vendors claiming work themselves rather than replacing
 * it: an assigned job is the landlord saying who they want on it, and the vendor
 * can still hand it back if they cannot take it — at which point it returns to
 * the open pool for anyone in the network to pick up.
 */
async function assignTicket(user: User, ticket: Ticket, req: Request): Promise<Response> {
  if (user.role !== "landlord") return fail("Landlords only.", 403);
  if (ticket.status === "closed") return fail("Reopen this task before assigning it.");

  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const raw = b?.vendorId;
  // An explicit null means "unassign" — distinct from not saying anything.
  const vendorId = raw === null || raw === "" || raw === undefined ? null : Number(raw);

  if (vendorId !== null) {
    const network = await networkVendors(user, await accessibleProperties(user));
    const vendor = network.find((v) => v.id === vendorId);
    if (!vendor) return fail("That vendor is not in your network.");
    if (ticket.assigned_vendor_id === vendorId) return fail(`Already assigned to ${vendor.display_name}.`);

    await db.run(
      "UPDATE tickets SET assigned_vendor_id = ?, updated_at = datetime('now') WHERE id = ?",
      [vendorId, ticket.id],
    );
    await addMessage(
      ticket.id, "system",
      `${user.display_name} assigned this to ${vendor.display_name}.`, user.id,
    );
  } else {
    if (!ticket.assigned_vendor_id) return fail("Nobody has this one.");
    await db.run(
      "UPDATE tickets SET assigned_vendor_id = NULL, updated_at = datetime('now') WHERE id = ?",
      [ticket.id],
    );
    await addMessage(ticket.id, "system", `${user.display_name} unassigned this.`, user.id);
  }

  return json({
    ticket: await visibleTicket(user, ticket.id),
    messages: await ticketMessages(ticket.id),
  });
}

/** The vendors a landlord can hand work to, for the assignment picker. */
async function listNetworkVendors(user: User, url: URL): Promise<Response> {
  if (user.role !== "landlord") return fail("Landlords only.", 403);
  const scope = await requestedScope(user, url);
  if (!scope) return fail("That property is not yours.", 403);
  if (!scope.length) return json({ vendors: [] });
  return json({ vendors: await networkVendors(user, scope) });
}

async function changePassword(
  user: User,
  req: Request,
  token: string | null,
): Promise<Response> {
  const b = (await req.json().catch(() => null)) as Record<string, string> | null;
  const current = String(b?.currentPassword ?? "");
  const next = String(b?.newPassword ?? "");

  if (!(await verifyPassword(current, user.password_hash))) {
    return fail("Current password is incorrect.", 403);
  }
  if (next.length < 8) return fail("New password must be at least 8 characters.");
  if (next === current) return fail("That is already your password.");

  await db.run("UPDATE users SET password_hash = ? WHERE id = ?", [
    await hashPassword(next),
    user.id,
  ]);
  // Everything signed in elsewhere is now stale — this is the point of the change.
  await dropOtherSessions(user.id, token);
  return json({ ok: true });
}

/**
 * The landlord's sidebar. Across the whole portfolio or one property, depending
 * on `?property=` — the shape of the answer is the same either way, so the
 * sidebar does not need two code paths. Each tenant and vendor carries the
 * property they belong to, which is what lets the "all" view group them and the
 * new-to-do form filter them.
 */
async function propertyOverview(user: User, url: URL): Promise<Response> {
  const scope = await requestedScope(user, url);
  if (!scope) return fail("That property is not yours.", 403);
  if (!scope.length) {
    return json({ tenants: [], vendors: [], counts: {}, properties: [] });
  }
  const holes = scope.map(() => "?").join(",");

  const tenants = await db.all(
    `SELECT u.id, u.display_name, u.unit, u.username, u.property_id, p.name AS property_name
     FROM users u JOIN properties p ON p.id = u.property_id
     WHERE u.property_id IN (${holes}) AND u.role = 'tenant'
     ORDER BY p.name, u.unit, u.display_name`,
    scope,
  );
  const vendors = await networkVendors(user, scope);
  const counts = await db.all<{ status: string; n: number }>(
    `SELECT status, COUNT(*) AS n FROM tickets
     WHERE property_id IN (${holes}) GROUP BY status`,
    scope,
  );
  const overdue = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM tickets
     WHERE property_id IN (${holes}) AND status != 'closed'
       AND due_at IS NOT NULL AND due_at < datetime('now')`,
    scope,
  );
  return json({
    tenants,
    vendors,
    counts: { ...Object.fromEntries(counts.map((c) => [c.status, c.n])), overdue: overdue?.n ?? 0 },
    // The per-property breakdown the "all properties" sidebar lists.
    properties: await propertiesFor(user),
  });
}

/**
 * The reader's own open work, grouped by the target it falls under.
 *
 * Scoped exactly as their list is — a tenant sees their own requests, a landlord
 * the portfolio, a vendor the properties they cover — so the page shows the same
 * world the rest of the app does rather than a second, wider view of it.
 */
async function slaTracking(user: User, url: URL) {
  const scope = await requestedScope(user, url);
  if (!scope || !scope.length) return { emergency: [], major: [], standard: [] };

  const clauses = [`t.property_id IN (${scope.map((_, i) => `$p${i}`).join(",")})`,
                   "t.status != 'closed'"];
  const params: Record<string, unknown> = {};
  scope.forEach((id, i) => { params[`p${i}`] = id; });

  if (user.role === "tenant") {
    clauses.push("t.tenant_id = $me");
    params.me = user.id;
  } else if (user.role === "vendor") {
    // Same rule as their list: triage is not work yet.
    clauses.push("t.status != 'triage'");
  }

  const rows = await db.all<{
    id: number; title: string; status: string; sla_tier: string | null;
    due_at: string | null; property_name: string; unit: string | null;
  }>(
    `SELECT t.id, t.title, t.status, t.sla_tier, t.due_at,
            p.name AS property_name, u.unit
     FROM tickets t
     JOIN properties p ON p.id = t.property_id
     LEFT JOIN users u ON u.id = t.tenant_id
     WHERE ${clauses.join(" AND ")}
     ORDER BY t.due_at ASC`,
    params,
  );

  const grouped: Record<string, typeof rows> = { emergency: [], major: [], standard: [] };
  for (const r of rows) grouped[r.sla_tier ?? "standard"]?.push(r);
  return grouped;
}

/**
 * Serve one photo.
 *
 * Access is exactly the thread's access: if you cannot open the ticket you
 * cannot fetch anything posted on it. The id is opaque and sequential, so this
 * check is the only thing standing between a guessed number and someone else's
 * photo — it runs before the bytes are read.
 */
async function servePhoto(user: User, id: number): Promise<Response> {
  const meta = await db.get<{ ticket_id: number }>(
    "SELECT ticket_id FROM attachments WHERE id = ?",
    [id],
  );
  if (!meta) return fail("Photo not found.", 404);
  if (!(await visibleTicket(user, meta.ticket_id))) return fail("Photo not found.", 404);

  const row = (await db.get<{ mime: string; bytes: Uint8Array }>(
    "SELECT mime, bytes FROM attachments WHERE id = ?",
    [id],
  ))!;
  return new Response(row.bytes as unknown as BodyInit, {
    headers: {
      "content-type": row.mime,
      // Immutable: an attachment's bytes never change, and the id is never
      // reused. Private, because the response depends on who asked.
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
}

/* -------------------------------------------------- property-list routes */

async function listProperties(user: User): Promise<Response> {
  return json({ properties: await propertiesFor(user), activeId: user.property_id });
}

async function addProperty(user: User, req: Request): Promise<Response> {
  const b = (await req.json().catch(() => null)) as Record<string, string> | null;
  // Same rule as sign-up: naming it is optional, and the fallback keeps the
  // header readable until they pick something.
  const count = (await propertiesFor(user)).length;
  const name = String(b?.name ?? "").trim() || `${user.display_name}'s property ${count + 1}`;
  const created = await createProperty(user, name);
  // activeId is still wherever the cursor was — the caller stays where it is.
  return json({ properties: await propertiesFor(user), activeId: user.property_id, created });
}

/** Move this account's cursor to another of its properties. */
async function selectProperty(user: User, propertyId: number): Promise<Response> {
  const allowed = user.role === "landlord"
    ? await landlordOwns(user.id, propertyId)
    : await vendorWorksOn(user.id, propertyId);
  if (!allowed) return fail("That property is not yours.", 403);

  await db.run("UPDATE users SET property_id = ? WHERE id = ?", [propertyId, user.id]);
  const fresh = (await db.get<User>("SELECT * FROM users WHERE id = ?", [user.id]))!;
  return json({ user: await publicUser(fresh) });
}

/**
 * Redeem a vendor code for an account that already exists.
 *
 * Two kinds are accepted and the vendor does not need to know which they hold:
 * a property code (V-) covering one building, or a landlord's portfolio code
 * (VP-) covering everything they own.
 */
async function joinPropertyAsVendor(user: User, req: Request): Promise<Response> {
  const b = (await req.json().catch(() => null)) as Record<string, string> | null;
  const code = String(b?.vendorCode ?? "").trim().toUpperCase();
  if (!code) return fail("Enter the vendor code the landlord gave you.");

  const owner = await db.get<{ id: number; display_name: string }>(
    "SELECT id, display_name FROM users WHERE vendor_code = ? AND role = 'landlord'",
    [code],
  );
  if (owner) {
    const already = await db.get(
      "SELECT 1 AS x FROM landlord_vendors WHERE landlord_id = ? AND vendor_id = ?",
      [owner.id, user.id],
    );
    if (already) return fail(`You already work with ${owner.display_name}.`);
    await db.run(
      "INSERT INTO landlord_vendors (landlord_id, vendor_id) VALUES (?, ?)",
      [owner.id, user.id],
    );
    const first = await db.get<{ id: number }>(
      "SELECT id FROM properties WHERE landlord_id = ? ORDER BY id LIMIT 1",
      [owner.id],
    );
    if (!user.property_id && first) {
      await db.run("UPDATE users SET property_id = ? WHERE id = ?", [first.id, user.id]);
    }
    const fresh = (await db.get<User>("SELECT * FROM users WHERE id = ?", [user.id]))!;
    return json({
      user: await publicUser(fresh),
      properties: await propertiesFor(fresh),
      created: first?.id ?? null,
    });
  }

  const property = await db.get<{ id: number }>(
    "SELECT id FROM properties WHERE vendor_code = ?",
    [code],
  );
  if (!property) return fail("No property matches that vendor code.");
  if (await vendorWorksOn(user.id, property.id)) return fail("You are already on that property.");

  await db.run(
    "INSERT INTO property_vendors (property_id, vendor_id) VALUES (?, ?)",
    [property.id, user.id],
  );
  // Redeeming a code widens what you can see; it does not say you want to look
  // only at the property you just joined. The exception is a vendor who had no
  // cursor at all — there is nothing to preserve, and leaving it empty would
  // leave them with a property but no property in view.
  if (!user.property_id) {
    await db.run("UPDATE users SET property_id = ? WHERE id = ?", [property.id, user.id]);
  }
  const fresh = (await db.get<User>("SELECT * FROM users WHERE id = ?", [user.id]))!;
  return json({
    user: await publicUser(fresh),
    properties: await propertiesFor(fresh),
    created: property.id,
  });
}

/* ------------------------------------------------------------------ chats */

/**
 * Direct messages, separate from ticket threads.
 *
 * A conversation is always between one tenant and the single landlord of their
 * property, and is keyed by the tenant. So "who am I allowed to talk to" has
 * exactly two answers: a tenant may only open their own conversation, and a
 * landlord may open the conversation of any tenant on their property. There is
 * no addressing scheme that could name anybody else.
 */
function landlordOf(propertyId: number): Promise<User | null> {
  // Via properties.landlord_id, not users.property_id — a landlord's own
  // property_id names only the building they happen to be looking at.
  return db.get<User>(
    "SELECT u.* FROM users u JOIN properties p ON p.landlord_id = u.id WHERE p.id = ?",
    [propertyId],
  );
}

/** The other party, or null if this user has no business in that conversation. */
async function chatPartner(user: User, tenantId: number): Promise<User | null> {
  if (user.role === "tenant") {
    // Tenants have exactly one conversation: their own, with their landlord.
    if (tenantId !== user.id) return null;
    return user.property_id ? landlordOf(user.property_id) : null;
  }
  if (user.role === "vendor") return null;
  // Any tenant on any property this landlord owns, not just the one in view.
  return propertyTenant(user, tenantId);
}

function markChatRead(tenantId: number, userId: number) {
  return db.run(
    `INSERT INTO chat_reads (tenant_id, user_id, last_read_id, updated_at)
     VALUES (?, ?, (SELECT COALESCE(MAX(id), 0) FROM chat_messages WHERE tenant_id = ?), datetime('now'))
     ON CONFLICT (tenant_id, user_id) DO UPDATE SET
       last_read_id = excluded.last_read_id, updated_at = excluded.updated_at`,
    [tenantId, userId, tenantId],
  );
}

async function chatReadMarker(tenantId: number, userId: number): Promise<number> {
  const row = await db.get<{ last_read_id: number }>(
    "SELECT last_read_id FROM chat_reads WHERE tenant_id = ? AND user_id = ?",
    [tenantId, userId],
  );
  return row?.last_read_id ?? 0;
}

function chatMessages(tenantId: number): Promise<ChatMessage[]> {
  return db.all<ChatMessage>(
    `SELECT m.*, u.display_name AS sender_name, u.role AS sender_role
     FROM chat_messages m JOIN users u ON u.id = m.sender_id
     WHERE m.tenant_id = ? ORDER BY m.id`,
    [tenantId],
  );
}

/**
 * The conversation list. A landlord gets one row per tenant — including tenants
 * nobody has messaged yet, so there is something to click to start. A tenant
 * gets the single row for their landlord.
 */
async function listChats(user: User, url: URL): Promise<Response> {
  // Direct messages are a tenant<->landlord channel. A vendor's conversation
  // belongs on the ticket, where everyone involved can see it.
  if (user.role === "vendor") return json({ chats: [] });
  if (user.role === "landlord") {
    const scope = await requestedScope(user, url);
    if (!scope) return fail("That property is not yours.", 403);
    if (!scope.length) return json({ chats: [] });
    // This query binds by name, so the IN list needs named holes too.
    const holes = scope.map((_, i) => `$s${i}`).join(",");
    // Across every property in scope, so a landlord is not made to hunt for a
    // message by first guessing which building it came from. The property rides
    // along on each row, because "Unit 4B" alone is ambiguous across buildings.
    const rows = await db.all(
      `SELECT u.id AS id, u.display_name AS name, u.unit AS subtitle,
              p.name AS property_name,
              (SELECT body FROM chat_messages m WHERE m.tenant_id = u.id ORDER BY m.id DESC LIMIT 1) AS last_message,
              (SELECT created_at FROM chat_messages m WHERE m.tenant_id = u.id ORDER BY m.id DESC LIMIT 1) AS last_at,
              (SELECT COUNT(*) FROM chat_messages m
                 WHERE m.tenant_id = u.id AND m.sender_id != $me
                   AND m.id > COALESCE((SELECT r.last_read_id FROM chat_reads r
                                        WHERE r.tenant_id = u.id AND r.user_id = $me), 0)) AS unread
       FROM users u JOIN properties p ON p.id = u.property_id
       WHERE u.property_id IN (${holes}) AND u.role = 'tenant'
       ORDER BY (last_at IS NULL), last_at DESC, p.name, u.unit, u.display_name`,
      { me: user.id, ...Object.fromEntries(scope.map((id, i) => [`s${i}`, id])) },
    );
    return json({ chats: rows });
  }

  const landlord = user.property_id ? await landlordOf(user.property_id) : null;
  if (!landlord) return json({ chats: [] }); // property with no landlord: nothing to show
  const row = await db.get(
    `SELECT $id AS id, $name AS name, 'your landlord' AS subtitle,
            (SELECT body FROM chat_messages m WHERE m.tenant_id = $id ORDER BY m.id DESC LIMIT 1) AS last_message,
            (SELECT created_at FROM chat_messages m WHERE m.tenant_id = $id ORDER BY m.id DESC LIMIT 1) AS last_at,
            (SELECT COUNT(*) FROM chat_messages m
               WHERE m.tenant_id = $id AND m.sender_id != $id
                 AND m.id > COALESCE((SELECT r.last_read_id FROM chat_reads r
                                      WHERE r.tenant_id = $id AND r.user_id = $id), 0)) AS unread`,
    { id: user.id, name: landlord.display_name },
  );
  return json({ chats: [row] });
}

async function openChat(user: User, tenantId: number): Promise<Response> {
  const partner = await chatPartner(user, tenantId);
  if (!partner) return fail("Conversation not found.", 404);

  const messages = await chatMessages(tenantId);
  const lastReadId = await chatReadMarker(tenantId, user.id);
  await markChatRead(tenantId, user.id);
  const property = user.role === "tenant" ? null : await db.get<{ name: string }>(
    "SELECT name FROM properties WHERE id = ?", [partner.property_id]);
  return json({
    conversation: {
      id: tenantId,
      name: partner.display_name,
      subtitle: user.role === "tenant"
        ? "your landlord"
        : [partner.unit, property?.name].filter(Boolean).join(" · "),
    },
    messages,
    lastReadId,
  });
}

async function sendChat(user: User, tenantId: number, req: Request): Promise<Response> {
  const partner = await chatPartner(user, tenantId);
  if (!partner) return fail("Conversation not found.", 404);

  const b = (await req.json().catch(() => null)) as Record<string, string> | null;
  const body = String(b?.body ?? "").trim();
  if (!body) return fail("Message is empty.");
  if (body.length > 4000) return fail("Message is too long.");

  // The conversation belongs to the tenant's property — a landlord viewing
  // another building must not stamp this message with that one.
  const propertyId = user.role === "tenant" ? user.property_id : partner.property_id;
  await db.run(
    "INSERT INTO chat_messages (property_id, tenant_id, sender_id, body) VALUES (?, ?, ?, ?)",
    [propertyId, tenantId, user.id, body],
  );
  await markChatRead(tenantId, user.id);
  return json({ messages: await chatMessages(tenantId) });
}

/* ------------------------------------------------------------- the router */

/** Handles every `/api/*` request. Returns null for anything else. */
export async function handleApi(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname;
  if (!path.startsWith("/api/")) return null;

  const cors = corsHeaders(req);
  // Preflight: the browser asks before sending the real cross-origin request.
  if (req.method === "OPTIONS") {
    return withCors(new Response(null, { status: 204 }), cors);
  }

  try {
    return withCors(await route(req, url, path), cors);
  } catch (err) {
    console.error("[api]", req.method, path, err);
    // A deployment with no database configured fails every request in the same
    // way, and "something went wrong" sends whoever set it up looking in the
    // wrong place. Say which thing is missing.
    const message = err instanceof Error && /TURSO_DATABASE_URL/.test(err.message)
      ? err.message
      : "Something went wrong on the server.";
    return withCors(fail(message, 500), cors);
  }
}

async function route(req: Request, url: URL, path: string): Promise<Response> {
  if (path === "/api/signup" && req.method === "POST") return await handleSignup(req);
  if (path === "/api/login" && req.method === "POST") return await handleLogin(req);

  if (path === "/api/logout" && req.method === "POST") {
    const token = currentToken(req);
    if (token) await destroySession(token);
    return json({ ok: true }, 200, { "set-cookie": clearCookie() });
  }

  const user = await currentUser(req);
  // The rules are readable without signing in — they are the policy, not
  // anybody's data. Signed in, the same response also carries the reader's own
  // open work under each target, which is the thing they actually came to check.
  if (path === "/api/standards" && req.method === "GET") {
    return json({
      standards: SLA_POLICY,
      tracking: user ? await slaTracking(user, url) : null,
    });
  }

  if (path === "/api/me") {
    return user ? json({ user: await publicUser(user) }) : json({ user: null });
  }
  if (!user) return fail("Please sign in.", 401);

  // The decision tree behind a new request. Served rather than copied into the
  // front end, so the form and the bot always agree on what an issue is called.
  if (path === "/api/intake" && req.method === "GET") return json(intakeForClient());

  if (path === "/api/property" && req.method === "GET") {
    if (user.role !== "landlord") return fail("Landlords only.", 403);
    return await propertyOverview(user, url);
  }

  if (path === "/api/schedules") {
    if (req.method === "GET") return await listSchedules(user, url);
    if (req.method === "POST") return await createSchedule(user, req);
  }
  const schedule = path.match(/^\/api\/schedules\/(\d+)$/);
  if (schedule) {
    const id = Number(schedule[1]);
    if (req.method === "POST") return await updateSchedule(user, id, req);
    if (req.method === "DELETE") return await deleteSchedule(user, id, req);
  }

  if (path === "/api/vendors" && req.method === "GET") {
    return await listNetworkVendors(user, url);
  }

  if (path === "/api/properties") {
    if (user.role === "tenant") return fail("Tenants belong to one property.", 403);
    if (req.method === "GET") return await listProperties(user);
    if (req.method === "POST") {
      if (user.role !== "landlord") return fail("Landlords only.", 403);
      return await addProperty(user, req);
    }
  }
  if (path === "/api/properties/join" && req.method === "POST") {
    if (user.role !== "vendor") return fail("Vendors only.", 403);
    return await joinPropertyAsVendor(user, req);
  }
  const selecting = path.match(/^\/api\/properties\/(\d+)\/select$/);
  if (selecting && req.method === "POST") {
    if (user.role === "tenant") return fail("Tenants belong to one property.", 403);
    return await selectProperty(user, Number(selecting[1]));
  }
  const photo = path.match(/^\/api\/attachments\/(\d+)$/);
  if (photo && req.method === "GET") return await servePhoto(user, Number(photo[1]));

  if (path === "/api/password" && req.method === "POST") {
    return await changePassword(user, req, currentToken(req));
  }
  if (path === "/api/chats" && req.method === "GET") {
    return await listChats(user, url);
  }
  const chat = path.match(/^\/api\/chats\/(\d+)(?:\/(messages))?$/);
  if (chat) {
    const tenantId = Number(chat[1]);
    if (!chat[2] && req.method === "GET") return await openChat(user, tenantId);
    if (chat[2] === "messages" && req.method === "POST") {
      return await sendChat(user, tenantId, req);
    }
  }

  if (path === "/api/tickets") {
    if (req.method === "GET") return await listTickets(user, url);
    if (req.method === "POST") return await createTicket(user, req);
  }

  const match = path.match(/^\/api\/tickets\/(\d+)(?:\/(\w+))?$/);
  if (match) {
    const ticket = await visibleTicket(user, Number(match[1]));
    if (!ticket) return fail("Request not found.", 404);
    const action = match[2];

    if (!action && req.method === "GET") {
      const messages = await ticketMessages(ticket.id);
      // Read the marker before moving it, so the client can draw a
      // "new messages" line where this user last left off.
      const lastReadId = await readMarker(ticket.id, user.id);
      await markRead(ticket.id, user.id); // opening the thread is reading it
      return json({ ticket, messages, lastReadId });
    }
    if (req.method === "POST") {
      if (action === "messages") return await postMessage(user, ticket, req);
      if (action === "update") return await updateTicket(user, ticket, req);
      if (action === "escalate") {
        if (user.role !== "tenant") return fail("Tenants only.", 403);
        return await escalate(user, ticket);
      }
      if (action === "close") return await closeTicket(user, ticket, req);
      if (action === "reopen") return await reopenTicket(user, ticket);
      if (action === "claim") return await claimTicket(user, ticket, true);
      if (action === "release") return await claimTicket(user, ticket, false);
      if (action === "assign") return await assignTicket(user, ticket, req);
    }
  }
  return fail("Not found.", 404);
}
