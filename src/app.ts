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
import { db, type ChatMessage, type Message, type Ticket, type User } from "./db";
import { triage, usingClaude } from "./bot";

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
    "access-control-allow-methods": "GET, POST, OPTIONS",
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
  "structural", "locks_security", "common_area", "other",
]);
const PRIORITIES = new Set(["low", "normal", "high", "urgent"]);

async function addMessage(
  ticketId: number,
  author: Message["author"],
  body: string,
  userId: number | null = null,
) {
  await db.run(
    "INSERT INTO messages (ticket_id, author, user_id, body) VALUES (?, ?, ?, ?)",
    [ticketId, author, userId, body.trim()],
  );
  await db.run("UPDATE tickets SET updated_at = datetime('now') WHERE id = ?", [ticketId]);
}

function ticketMessages(ticketId: number): Promise<Message[]> {
  return db.all<Message>(
    `SELECT m.*, u.display_name AS author_name
     FROM messages m LEFT JOIN users u ON u.id = m.user_id
     WHERE m.ticket_id = ? ORDER BY m.id`,
    [ticketId],
  );
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

/** Anyone on this property who is a tenant — used to target a landlord to-do. */
function propertyTenant(user: User, tenantId: number): Promise<User | null> {
  return db.get<User>(
    "SELECT * FROM users WHERE id = ? AND property_id = ? AND role = 'tenant'",
    [tenantId, user.property_id],
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
            c.display_name AS creator_name, c.role AS creator_role
     FROM tickets t
     LEFT JOIN users u ON u.id = t.tenant_id
     LEFT JOIN users c ON c.id = t.created_by
     WHERE t.id = ?`,
    [id],
  );
  if (!t) return null;
  if (t.property_id !== user.property_id) return null;
  if (user.role === "tenant" && t.tenant_id !== user.id) return null;
  return t;
}

async function makeJoinCode(): Promise<string> {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1
  for (let attempt = 0; attempt < 50; attempt++) {
    const code = Array.from(
      { length: 6 },
      () => alphabet[Math.floor(Math.random() * alphabet.length)],
    ).join("");
    const taken = await db.get("SELECT 1 AS x FROM properties WHERE join_code = ?", [code]);
    if (!taken) return code;
  }
  throw new Error("could not allocate a join code");
}

async function publicUser(u: User) {
  const property = (await db.get<{ name: string; join_code: string }>(
    "SELECT name, join_code FROM properties WHERE id = ?",
    [u.property_id],
  ))!;
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    displayName: u.display_name,
    unit: u.unit,
    property: {
      id: u.property_id,
      name: property.name,
      // The join code is a shared secret for the building — landlords only.
      joinCode: u.role === "landlord" ? property.join_code : undefined,
    },
    botEngine: usingClaude ? "claude" : "rules",
  };
}

/**
 * Run the bot over a ticket in triage and apply whatever it decided.
 * Returns the bot's own message plus any status change.
 */
async function runTriage(ticket: Ticket) {
  const history = await ticketMessages(ticket.id);
  const result = await triage(ticket.title, history);

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
  const role = b.role === "landlord" ? "landlord" : "tenant";

  if (!/^[A-Za-z0-9._-]{3,32}$/.test(username)) {
    return fail("Username must be 3-32 characters (letters, numbers, . _ -).");
  }
  if (password.length < 8) return fail("Password must be at least 8 characters.");
  if (!displayName) return fail("Please enter your name.");
  if (await db.get("SELECT 1 AS x FROM users WHERE username = ?", [username])) {
    return fail("That username is taken.");
  }

  let propertyId: number;
  let unit: string | null = null;

  if (role === "landlord") {
    const propertyName = String(b.propertyName ?? "").trim();
    if (!propertyName) return fail("Please name the property you manage.");
    const res = (await db.get<{ id: number }>(
      "INSERT INTO properties (name, join_code) VALUES (?, ?) RETURNING id",
      [propertyName, await makeJoinCode()],
    ))!;
    propertyId = res.id;
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

  const token = await createSession(user.id);
  return json({ user: await publicUser(user), token }, 200, {
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
  const clauses: string[] = ["t.property_id = $property"];
  const params: Record<string, unknown> = { property: user.property_id, me: user.id };

  if (user.role === "tenant") {
    clauses.push("t.tenant_id = $tenant");
    params.tenant = user.id;
  } else {
    // Triage threads are the tenant's private conversation with the bot until escalated.
    clauses.push("t.status != 'triage'");
  }
  if (status && status !== "all") {
    clauses.push("t.status = $status");
    params.status = status;
  }

  const tickets = await db.all(
    `SELECT t.*, u.display_name AS tenant_name, u.unit AS tenant_unit,
            c.display_name AS creator_name, c.role AS creator_role,
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
     WHERE ${clauses.join(" AND ")}
     ORDER BY
       CASE t.status WHEN 'open' THEN 0 WHEN 'triage' THEN 1 ELSE 2 END,
       CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
       t.updated_at DESC`,
    params,
  );

  return json({ tickets });
}

async function createTicket(user: User, req: Request): Promise<Response> {
  const b = (await req.json().catch(() => null)) as Record<string, string> | null;
  const title = String(b?.title ?? "").trim();
  const description = String(b?.description ?? "").trim();
  if (!title) return fail("Give the request a short title.");

  if (user.role === "tenant") {
    if (!description) return fail("Describe what is going on so the assistant can help.");
    const ticket = (await db.get<Ticket>(
      `INSERT INTO tickets (property_id, tenant_id, created_by, title, summary, status)
       VALUES (?, ?, ?, ?, ?, 'triage') RETURNING *`,
      [user.property_id, user.id, user.id, title, title],
    ))!;

    await addMessage(ticket.id, "tenant", description, user.id);
    await runTriage(ticket);
    await markRead(ticket.id, user.id);
    return json({
      ticket: await visibleTicket(user, ticket.id),
      messages: await ticketMessages(ticket.id),
    });
  }

  // Landlords add to-dos straight to the list — no triage. A to-do can be kept
  // internal (tenant_id NULL) or raised with a specific tenant, who then sees it
  // in their own list and can talk it through in the same thread.
  const priority = PRIORITIES.has(String(b?.priority)) ? String(b?.priority) : "normal";
  const category = CATEGORIES.has(String(b?.category)) ? String(b?.category) : "other";

  let tenantId: number | null = null;
  if (b?.tenantId) {
    const tenant = await propertyTenant(user, Number(b.tenantId));
    if (!tenant) return fail("That tenant is not on this property.");
    tenantId = tenant.id;
  }

  const ticket = (await db.get<Ticket>(
    `INSERT INTO tickets (property_id, tenant_id, created_by, title, summary, category, priority, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open') RETURNING *`,
    [user.property_id, tenantId, user.id, title, description || title, category, priority],
  ))!;

  if (description) await addMessage(ticket.id, "landlord", description, user.id);
  if (tenantId) {
    await addMessage(ticket.id, "system", `${user.display_name} raised this with the tenant.`);
  }
  await markRead(ticket.id, user.id);
  return json({ ticket, messages: await ticketMessages(ticket.id) });
}

async function postMessage(user: User, ticket: Ticket, req: Request): Promise<Response> {
  const b = (await req.json().catch(() => null)) as Record<string, string> | null;
  const body = String(b?.body ?? "").trim();
  if (!body) return fail("Message is empty.");
  if (ticket.status === "closed") return fail("This request is closed. Reopen it to keep talking.");

  await addMessage(ticket.id, user.role, body, user.id);

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

async function propertyOverview(user: User): Promise<Response> {
  const tenants = await db.all(
    `SELECT id, display_name, unit, username FROM users
     WHERE property_id = ? AND role = 'tenant' ORDER BY unit, display_name`,
    [user.property_id],
  );
  const counts = await db.all<{ status: string; n: number }>(
    "SELECT status, COUNT(*) AS n FROM tickets WHERE property_id = ? GROUP BY status",
    [user.property_id],
  );
  return json({
    tenants,
    counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
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
  return db.get<User>(
    "SELECT * FROM users WHERE property_id = ? AND role = 'landlord' ORDER BY id LIMIT 1",
    [propertyId],
  );
}

/** The other party, or null if this user has no business in that conversation. */
async function chatPartner(user: User, tenantId: number): Promise<User | null> {
  if (user.role === "tenant") {
    // Tenants have exactly one conversation: their own, with their landlord.
    if (tenantId !== user.id) return null;
    return landlordOf(user.property_id);
  }
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
async function listChats(user: User): Promise<Response> {
  if (user.role === "landlord") {
    const rows = await db.all(
      `SELECT u.id AS id, u.display_name AS name, u.unit AS subtitle,
              (SELECT body FROM chat_messages m WHERE m.tenant_id = u.id ORDER BY m.id DESC LIMIT 1) AS last_message,
              (SELECT created_at FROM chat_messages m WHERE m.tenant_id = u.id ORDER BY m.id DESC LIMIT 1) AS last_at,
              (SELECT COUNT(*) FROM chat_messages m
                 WHERE m.tenant_id = u.id AND m.sender_id != $me
                   AND m.id > COALESCE((SELECT r.last_read_id FROM chat_reads r
                                        WHERE r.tenant_id = u.id AND r.user_id = $me), 0)) AS unread
       FROM users u
       WHERE u.property_id = $property AND u.role = 'tenant'
       ORDER BY (last_at IS NULL), last_at DESC, u.unit, u.display_name`,
      { me: user.id, property: user.property_id },
    );
    return json({ chats: rows });
  }

  const landlord = await landlordOf(user.property_id);
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
  return json({
    conversation: {
      id: tenantId,
      name: partner.display_name,
      subtitle: user.role === "tenant" ? "your landlord" : partner.unit,
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

  await db.run(
    "INSERT INTO chat_messages (property_id, tenant_id, sender_id, body) VALUES (?, ?, ?, ?)",
    [user.property_id, tenantId, user.id, body],
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
    return withCors(fail("Something went wrong on the server.", 500), cors);
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
  if (path === "/api/me") {
    return user ? json({ user: await publicUser(user) }) : json({ user: null });
  }
  if (!user) return fail("Please sign in.", 401);

  if (path === "/api/property" && req.method === "GET") {
    if (user.role !== "landlord") return fail("Landlords only.", 403);
    return await propertyOverview(user);
  }
  if (path === "/api/password" && req.method === "POST") {
    return await changePassword(user, req, currentToken(req));
  }
  if (path === "/api/chats" && req.method === "GET") {
    return await listChats(user);
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
    }
  }
  return fail("Not found.", 404);
}
