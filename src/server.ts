import { resolve } from "node:path";
import { db, type Message, type Ticket, type User } from "./db";
import {
  clearCookie,
  createSession,
  currentToken,
  currentUser,
  destroySession,
  hashPassword,
  sessionCookie,
  verifyPassword,
} from "./auth";
import { triage, usingClaude } from "./bot";

const PORT = Number(process.env.PORT ?? 4321);
const PUBLIC_DIR = new URL("../public/", import.meta.url).pathname;

/* --------------------------------------------------------------- helpers */

/** bun:sqlite named bindings are flat — no nested objects. */
type Bindings = Record<string, string | number | null>;

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const fail = (message: string, status = 400) => json({ error: message }, status);

function touch(ticketId: number) {
  db.query("UPDATE tickets SET updated_at = datetime('now') WHERE id = ?").run(ticketId);
}

function addMessage(
  ticketId: number,
  author: Message["author"],
  body: string,
  userId: number | null = null,
) {
  db.query(
    "INSERT INTO messages (ticket_id, author, user_id, body) VALUES (?, ?, ?, ?)",
  ).run(ticketId, author, userId, body.trim());
  touch(ticketId);
}

function ticketMessages(ticketId: number): Message[] {
  return db
    .query<Message, [number]>(
      `SELECT m.*, u.display_name AS author_name
       FROM messages m LEFT JOIN users u ON u.id = m.user_id
       WHERE m.ticket_id = ? ORDER BY m.id`,
    )
    .all(ticketId);
}

/** Tenants see only their own tickets; landlords see everything on their property. */
function visibleTicket(user: User, id: number): Ticket | null {
  const t = db.query<Ticket, [number]>("SELECT * FROM tickets WHERE id = ?").get(id);
  if (!t) return null;
  if (t.property_id !== user.property_id) return null;
  if (user.role === "tenant" && t.tenant_id !== user.id) return null;
  return t;
}

function makeJoinCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1
  for (let attempt = 0; attempt < 50; attempt++) {
    const code = Array.from(
      { length: 6 },
      () => alphabet[Math.floor(Math.random() * alphabet.length)],
    ).join("");
    const taken = db.query("SELECT 1 FROM properties WHERE join_code = ?").get(code);
    if (!taken) return code;
  }
  throw new Error("could not allocate a join code");
}

function publicUser(u: User) {
  const property = db
    .query<{ name: string; join_code: string }, [number]>(
      "SELECT name, join_code FROM properties WHERE id = ?",
    )
    .get(u.property_id)!;
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
  const history = ticketMessages(ticket.id);
  const result = await triage(ticket.title, history);

  addMessage(ticket.id, "bot", result.reply);

  if (result.action === "escalate") {
    db.query(
      `UPDATE tickets
       SET status = 'open', category = ?, priority = ?, summary = ?, updated_at = datetime('now')
       WHERE id = ?`,
    ).run(result.category, result.priority, result.summary, ticket.id);
    addMessage(ticket.id, "system", "Sent to the landlord's to-do list.");
  } else if (result.action === "resolved") {
    db.query(
      `UPDATE tickets
       SET status = 'closed', category = ?, summary = ?, resolution = ?, closed_by = 'bot',
           closed_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ?`,
    ).run(
      result.category,
      result.summary,
      "Resolved during triage — no maintenance visit needed.",
      ticket.id,
    );
    addMessage(ticket.id, "system", "Closed without needing maintenance.");
  } else {
    db.query(
      "UPDATE tickets SET category = ?, priority = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(result.category, result.priority, ticket.id);
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
  if (db.query("SELECT 1 FROM users WHERE username = ?").get(username)) {
    return fail("That username is taken.");
  }

  let propertyId: number;
  let unit: string | null = null;

  if (role === "landlord") {
    const propertyName = String(b.propertyName ?? "").trim();
    if (!propertyName) return fail("Please name the property you manage.");
    const res = db
      .query("INSERT INTO properties (name, join_code) VALUES (?, ?) RETURNING id")
      .get(propertyName, makeJoinCode()) as { id: number };
    propertyId = res.id;
  } else {
    const joinCode = String(b.joinCode ?? "").trim().toUpperCase();
    unit = String(b.unit ?? "").trim();
    if (!joinCode) return fail("Enter the property code your landlord gave you.");
    if (!unit) return fail("Enter your unit number.");
    const property = db
      .query<{ id: number }, [string]>("SELECT id FROM properties WHERE join_code = ?")
      .get(joinCode);
    if (!property) return fail("No property matches that code.");
    propertyId = property.id;
  }

  const hash = await hashPassword(password);
  const user = db
    .query(
      `INSERT INTO users (username, password_hash, role, display_name, property_id, unit)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(username, hash, role, displayName, propertyId, unit) as User;

  const token = createSession(user.id);
  return json({ user: publicUser(user) }, 200, { "set-cookie": sessionCookie(req, token) });
}

async function handleLogin(req: Request): Promise<Response> {
  const b = (await req.json().catch(() => null)) as Record<string, string> | null;
  if (!b) return fail("Malformed request body.");

  const user = db
    .query<User, [string]>("SELECT * FROM users WHERE username = ?")
    .get(String(b.username ?? "").trim());

  // Same message either way, so this can't be used to enumerate usernames.
  if (!user || !(await verifyPassword(String(b.password ?? ""), user.password_hash))) {
    return fail("Incorrect username or password.", 401);
  }

  const token = createSession(user.id);
  return json({ user: publicUser(user) }, 200, { "set-cookie": sessionCookie(req, token) });
}

function listTickets(user: User, url: URL): Response {
  const status = url.searchParams.get("status"); // open | closed | triage | all
  const clauses: string[] = ["t.property_id = $property"];
  const params: Bindings = { $property: user.property_id };

  if (user.role === "tenant") {
    clauses.push("t.tenant_id = $tenant");
    params.$tenant = user.id;
  } else {
    // Triage threads are the tenant's private conversation with the bot until escalated.
    clauses.push("t.status != 'triage'");
  }
  if (status && status !== "all") {
    clauses.push("t.status = $status");
    params.$status = status;
  }

  const rows = db
    .query(
      `SELECT t.*, u.display_name AS tenant_name, u.unit AS tenant_unit,
              (SELECT COUNT(*) FROM messages m WHERE m.ticket_id = t.id) AS message_count,
              (SELECT m.body FROM messages m WHERE m.ticket_id = t.id ORDER BY m.id DESC LIMIT 1) AS last_message
       FROM tickets t LEFT JOIN users u ON u.id = t.tenant_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY
         CASE t.status WHEN 'open' THEN 0 WHEN 'triage' THEN 1 ELSE 2 END,
         CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
         t.updated_at DESC`,
    )
    .all(params);

  return json({ tickets: rows });
}

async function createTicket(user: User, req: Request): Promise<Response> {
  const b = (await req.json().catch(() => null)) as Record<string, string> | null;
  const title = String(b?.title ?? "").trim();
  const description = String(b?.description ?? "").trim();
  if (!title) return fail("Give the request a short title.");

  if (user.role === "tenant") {
    if (!description) return fail("Describe what is going on so the assistant can help.");
    const ticket = db
      .query(
        `INSERT INTO tickets (property_id, tenant_id, created_by, title, summary, status)
         VALUES (?, ?, ?, ?, ?, 'triage') RETURNING *`,
      )
      .get(user.property_id, user.id, user.id, title, title) as Ticket;

    addMessage(ticket.id, "tenant", description, user.id);
    await runTriage(ticket);
    return json({ ticket: visibleTicket(user, ticket.id), messages: ticketMessages(ticket.id) });
  }

  // Landlords add their own to-do items — no triage, straight onto the list.
  const priority = ["low", "normal", "high", "urgent"].includes(String(b?.priority))
    ? String(b?.priority)
    : "normal";
  const ticket = db
    .query(
      `INSERT INTO tickets (property_id, tenant_id, created_by, title, summary, category, priority, status)
       VALUES (?, NULL, ?, ?, ?, ?, ?, 'open') RETURNING *`,
    )
    .get(user.property_id, user.id, title, description || title, String(b?.category ?? "other"), priority) as Ticket;

  if (description) addMessage(ticket.id, "landlord", description, user.id);
  return json({ ticket, messages: ticketMessages(ticket.id) });
}

async function postMessage(user: User, ticket: Ticket, req: Request): Promise<Response> {
  const b = (await req.json().catch(() => null)) as Record<string, string> | null;
  const body = String(b?.body ?? "").trim();
  if (!body) return fail("Message is empty.");
  if (ticket.status === "closed") return fail("This request is closed. Reopen it to keep talking.");

  addMessage(ticket.id, user.role, body, user.id);

  // While a request is in triage the bot owns the conversation.
  let botResult = null;
  if (ticket.status === "triage" && user.role === "tenant") {
    botResult = await runTriage(ticket);
  }

  return json({
    ticket: visibleTicket(user, ticket.id),
    messages: ticketMessages(ticket.id),
    bot: botResult,
  });
}

function escalate(user: User, ticket: Ticket): Response {
  if (ticket.status !== "triage") return fail("This request is already with your landlord.");
  db.query(
    `UPDATE tickets SET status = 'open', updated_at = datetime('now') WHERE id = ?`,
  ).run(ticket.id);
  addMessage(ticket.id, "system", `${user.display_name} sent this to the landlord.`);
  return json({ ticket: visibleTicket(user, ticket.id), messages: ticketMessages(ticket.id) });
}

async function closeTicket(user: User, ticket: Ticket, req: Request): Promise<Response> {
  if (ticket.status === "closed") return fail("Already closed.");
  const b = (await req.json().catch(() => null)) as Record<string, string> | null;
  const resolution = String(b?.resolution ?? "").trim() || "Marked complete.";

  db.query(
    `UPDATE tickets
     SET status = 'closed', resolution = ?, closed_by = ?, closed_at = datetime('now'),
         updated_at = datetime('now')
     WHERE id = ?`,
  ).run(resolution, user.display_name, ticket.id);
  addMessage(ticket.id, "system", `Closed by ${user.display_name}: ${resolution}`, user.id);
  return json({ ticket: visibleTicket(user, ticket.id), messages: ticketMessages(ticket.id) });
}

function reopenTicket(user: User, ticket: Ticket): Response {
  if (ticket.status !== "closed") return fail("This request is not closed.");
  // A tenant reopening a bot-closed thread goes back to the bot; anything else
  // goes back on the landlord's list.
  const next = ticket.closed_by === "bot" && user.role === "tenant" ? "triage" : "open";
  db.query(
    `UPDATE tickets
     SET status = ?, resolution = NULL, closed_by = NULL, closed_at = NULL,
         updated_at = datetime('now')
     WHERE id = ?`,
  ).run(next, ticket.id);
  addMessage(ticket.id, "system", `Reopened by ${user.display_name}.`, user.id);
  return json({ ticket: visibleTicket(user, ticket.id), messages: ticketMessages(ticket.id) });
}

function propertyOverview(user: User): Response {
  const tenants = db
    .query(
      `SELECT id, display_name, unit, username FROM users
       WHERE property_id = ? AND role = 'tenant' ORDER BY unit, display_name`,
    )
    .all(user.property_id);
  const counts = db
    .query(
      `SELECT status, COUNT(*) AS n FROM tickets WHERE property_id = ? GROUP BY status`,
    )
    .all(user.property_id) as { status: string; n: number }[];
  return json({
    tenants,
    counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
  });
}

/* ----------------------------------------------------------------- serve */

const server = Bun.serve({
  port: PORT,
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path.startsWith("/api/")) {
      try {
        if (path === "/api/signup" && req.method === "POST") return await handleSignup(req);
        if (path === "/api/login" && req.method === "POST") return await handleLogin(req);

        if (path === "/api/logout" && req.method === "POST") {
          const token = currentToken(req);
          if (token) destroySession(token);
          return json({ ok: true }, 200, { "set-cookie": clearCookie() });
        }

        const user = currentUser(req);
        if (path === "/api/me") {
          return user ? json({ user: publicUser(user) }) : json({ user: null });
        }
        if (!user) return fail("Please sign in.", 401);

        if (path === "/api/property" && req.method === "GET") {
          if (user.role !== "landlord") return fail("Landlords only.", 403);
          return propertyOverview(user);
        }
        if (path === "/api/tickets") {
          if (req.method === "GET") return listTickets(user, url);
          if (req.method === "POST") return await createTicket(user, req);
        }

        const match = path.match(/^\/api\/tickets\/(\d+)(?:\/(\w+))?$/);
        if (match) {
          const ticket = visibleTicket(user, Number(match[1]));
          if (!ticket) return fail("Request not found.", 404);
          const action = match[2];

          if (!action && req.method === "GET") {
            return json({ ticket, messages: ticketMessages(ticket.id) });
          }
          if (req.method === "POST") {
            if (action === "messages") return await postMessage(user, ticket, req);
            if (action === "escalate") {
              if (user.role !== "tenant") return fail("Tenants only.", 403);
              return escalate(user, ticket);
            }
            if (action === "close") return await closeTicket(user, ticket, req);
            if (action === "reopen") return reopenTicket(user, ticket);
          }
        }
        return fail("Not found.", 404);
      } catch (err) {
        console.error("[api]", req.method, path, err);
        return fail("Something went wrong on the server.", 500);
      }
    }

    // Static files. resolve() collapses any ".." before the prefix check, so a
    // crafted path can't reach outside public/.
    const rel = path === "/" ? "index.html" : decodeURIComponent(path).replace(/^\/+/, "");
    const target = resolve(PUBLIC_DIR, rel);
    if (target.startsWith(PUBLIC_DIR)) {
      const file = Bun.file(target);
      if (await file.exists()) return new Response(file);
    }
    // Unknown paths fall through to the app shell (client-side routing).
    return new Response(Bun.file(PUBLIC_DIR + "index.html"));
  },
});

console.log(
  `knoknok listening on http://localhost:${server.port}  (triage bot: ${usingClaude ? "Claude Opus 5" : "built-in rules — set ANTHROPIC_API_KEY for Claude"})`,
);
