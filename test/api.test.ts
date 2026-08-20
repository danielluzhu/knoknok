/**
 * End-to-end API tests. Boots a real server against a throwaway database,
 * then drives it over HTTP exactly as the browser does.
 *
 *   bun test
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

const PORT = 4399;
const DB = "data/test-knoknok.db";
/**
 * By default the suite boots the Bun dev server. Point TEST_BASE_URL at
 * something else — the Vercel bundle running under Node, or a preview
 * deployment — to run exactly these tests against that instead.
 */
const EXTERNAL = process.env.TEST_BASE_URL?.replace(/\/$/, "");
const BASE = EXTERNAL ?? `http://localhost:${PORT}`;
let server: ReturnType<typeof Bun.spawn> | null = null;

/** A cookie jar per signed-in user, so tests can hold several sessions at once. */
class Session {
  cookie = "";
  async req(path: string, init: { method?: string; body?: unknown } = {}) {
    const res = await fetch(BASE + path, {
      method: init.method ?? "GET",
      headers: {
        "content-type": "application/json",
        ...(this.cookie ? { cookie: this.cookie } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) this.cookie = setCookie.split(";")[0]!;
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data: data as any };
  }
  post(path: string, body?: unknown) { return this.req(path, { method: "POST", body: body ?? {} }); }
  get(path: string) { return this.req(path); }
}

const uniq = (p: string) => `${p}${Math.floor(Math.random() * 1e6)}`;

beforeAll(async () => {
  if (!EXTERNAL) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try { rmSync(DB + suffix); } catch { /* first run */ }
    }
    server = Bun.spawn(["bun", "run", "server.ts"], {
      env: {
        ...process.env,
        PORT: String(PORT),
        DB_PATH: DB,
        ANTHROPIC_API_KEY: "",
        ALLOWED_ORIGINS: "https://example.github.io",
      },
      stdout: "pipe", stderr: "pipe",
    });
  }
  // Wait for the port to answer rather than sleeping a fixed amount.
  for (let i = 0; i < 100; i++) {
    try { await fetch(BASE + "/api/me"); return; } catch { await Bun.sleep(100); }
  }
  throw new Error(`no server answering at ${BASE}`);
});

afterAll(() => {
  server?.kill();
  if (EXTERNAL) return;
  for (const suffix of ["", "-wal", "-shm"]) {
    try { rmSync(DB + suffix); } catch { /* already gone */ }
  }
});

/* ------------------------------------------------------------------ setup */

const landlord = new Session();
const tenant = new Session();
const other = new Session();
let joinCode = "";
let tenantId = 0;

describe("accounts", () => {
  test("landlord signup creates a property with a join code", async () => {
    const { status, data } = await landlord.post("/api/signup", {
      role: "landlord", username: uniq("dana"), password: "password123",
      displayName: "Dana W", propertyName: "Maple Court",
    });
    expect(status).toBe(200);
    expect(data.user.role).toBe("landlord");
    expect(data.user.property.joinCode).toMatch(/^[A-Z2-9]{6}$/);
    joinCode = data.user.property.joinCode;
  });

  test("tenant joins with the code", async () => {
    const { status, data } = await tenant.post("/api/signup", {
      role: "tenant", username: uniq("jo"), password: "password123",
      displayName: "Jo P", joinCode: joinCode.toLowerCase(), unit: "2A",
    });
    expect(status).toBe(200);
    expect(data.user.unit).toBe("2A");
    // The join code is a building secret — tenants must not receive it.
    expect(data.user.property.joinCode).toBeUndefined();
    tenantId = data.user.id;
  });

  test("a tenant on another property is isolated", async () => {
    const { data } = await other.post("/api/signup", {
      role: "landlord", username: uniq("morgan"), password: "password123",
      displayName: "Morgan L", propertyName: "Birch Row",
    });
    expect(data.user.property.id).not.toBe(0);
  });

  test.each([
    ["short username", { username: "ab", password: "password123", displayName: "X", joinCode: "", unit: "1" }],
    ["short password", { username: uniq("u"), password: "short", displayName: "X", joinCode: "", unit: "1" }],
    ["no display name", { username: uniq("u"), password: "password123", displayName: "", joinCode: "", unit: "1" }],
  ])("signup rejects %s", async (_label, body) => {
    const { status } = await new Session().post("/api/signup", { role: "tenant", ...body });
    expect(status).toBe(400);
  });

  test("signup rejects an unknown join code", async () => {
    const { status, data } = await new Session().post("/api/signup", {
      role: "tenant", username: uniq("nobody"), password: "password123",
      displayName: "N", joinCode: "ZZZZZZ", unit: "1A",
    });
    expect(status).toBe(400);
    expect(data.error).toContain("No property");
  });

  test("wrong password is refused, and says nothing about which half was wrong", async () => {
    const { status, data } = await new Session().post("/api/login", {
      username: "definitely-not-a-user", password: "whatever",
    });
    expect(status).toBe(401);
    expect(data.error).toBe("Incorrect username or password.");
  });

  test("repeated failures lock the account out", async () => {
    const victim = uniq("throttle");
    await new Session().post("/api/signup", {
      role: "tenant", username: victim, password: "password123",
      displayName: "T", joinCode, unit: "9Z",
    });
    for (let i = 0; i < 8; i++) {
      await new Session().post("/api/login", { username: victim, password: "wrong" });
    }
    const { status } = await new Session().post("/api/login", { username: victim, password: "password123" });
    expect(status).toBe(429);
  });
});

/* ------------------------------------------------------------------ triage */

describe("tenant triage", () => {
  test("an easy fix is offered, then the request closes without maintenance", async () => {
    const created = await tenant.post("/api/tickets", {
      title: "Bathroom outlet dead",
      description: "The outlet in my bathroom has no power at all",
    });
    expect(created.status).toBe(200);
    expect(created.data.ticket.status).toBe("triage");
    expect(created.data.messages.at(-1).author).toBe("bot");
    expect(created.data.messages.at(-1).body).toContain("GFCI");

    const done = await tenant.post(`/api/tickets/${created.data.ticket.id}/messages`, {
      body: "That worked, thanks!",
    });
    expect(done.data.ticket.status).toBe("closed");
    expect(done.data.ticket.closed_by).toBe("bot");
  });

  test("an unresolved issue escalates with a category and a summary", async () => {
    const { data } = await tenant.post("/api/tickets", {
      title: "Kitchen sink won't drain",
      description: "The kitchen sink is filling up and draining really slowly",
    });
    const id = data.ticket.id;
    await tenant.post(`/api/tickets/${id}/messages`, { body: "Tried the plunger, no luck." });
    const last = await tenant.post(`/api/tickets/${id}/messages`, { body: "Cleared the trap too, still blocked." });
    expect(last.data.ticket.status).toBe("open");
    expect(last.data.ticket.category).toBe("plumbing");
    expect(last.data.ticket.summary).toContain("self-help");
  });

  test("an emergency skips troubleshooting entirely", async () => {
    const { data } = await tenant.post("/api/tickets", {
      title: "Water pouring from ceiling",
      description: "Water is gushing out of the ceiling and flooding the hallway",
    });
    expect(data.ticket.status).toBe("open");
    expect(data.ticket.priority).toBe("urgent");
    expect(data.messages[1].body).toContain("flooding");
  });

  test("the tenant can bypass the bot", async () => {
    const { data } = await tenant.post("/api/tickets", {
      title: "Bedroom door squeaks", description: "It squeaks every time it moves",
    });
    expect(data.ticket.status).toBe("triage");
    const out = await tenant.post(`/api/tickets/${data.ticket.id}/escalate`);
    expect(out.data.ticket.status).toBe("open");
  });

  test("a request needs a description", async () => {
    const { status } = await tenant.post("/api/tickets", { title: "Just a title" });
    expect(status).toBe(400);
  });
});

/* --------------------------------------------------------------- landlord */

describe("landlord to-do list", () => {
  let internalId = 0;
  let sharedId = 0;

  test("triage threads stay private until they escalate", async () => {
    const { data } = await landlord.get("/api/tickets?status=all");
    expect(data.tickets.every((t: any) => t.status !== "triage")).toBe(true);
  });

  test("an internal to-do is invisible to tenants", async () => {
    const made = await landlord.post("/api/tickets", {
      title: "Renew building insurance", priority: "low", category: "other",
    });
    internalId = made.data.ticket.id;
    expect(made.data.ticket.status).toBe("open");
    expect(made.data.ticket.tenant_id).toBeNull();
    const seen = await tenant.get(`/api/tickets/${internalId}`);
    expect(seen.status).toBe(404);
  });

  test("a to-do raised with a tenant is visible to them", async () => {
    const made = await landlord.post("/api/tickets", {
      title: "Boiler service Thursday", description: "Engineer needs 30 minutes in your kitchen.",
      priority: "high", category: "hvac", tenantId,
    });
    sharedId = made.data.ticket.id;
    const seen = await tenant.get(`/api/tickets/${sharedId}`);
    expect(seen.status).toBe(200);
    expect(seen.data.ticket.creator_role).toBe("landlord");
    // and the tenant can reply in the same thread
    const reply = await tenant.post(`/api/tickets/${sharedId}/messages`, { body: "Thursday works." });
    expect(reply.status).toBe(200);
  });

  test("a to-do cannot be aimed at someone else's tenant", async () => {
    const { status } = await other.post("/api/tickets", {
      title: "Nosy", tenantId,
    });
    expect(status).toBe(400);
  });

  test("the landlord can re-file a task, and it is recorded in the thread", async () => {
    const { data } = await landlord.post(`/api/tickets/${sharedId}/update`, {
      priority: "urgent", category: "plumbing",
    });
    expect(data.ticket.priority).toBe("urgent");
    expect(data.ticket.category).toBe("plumbing");
    expect(data.messages.at(-1).body).toContain("set priority to urgent");
  });

  test.each([
    ["priority", { priority: "asap" }],
    ["category", { category: "vibes" }],
    ["title", { title: "   " }],
  ])("re-filing rejects a bad %s", async (_l, body) => {
    const { status } = await landlord.post(`/api/tickets/${sharedId}/update`, body);
    expect(status).toBe(400);
  });

  test("tenants cannot re-file anything", async () => {
    const { status } = await tenant.post(`/api/tickets/${sharedId}/update`, { priority: "low" });
    expect(status).toBe(403);
  });

  test("closing records who did it and why; reopening clears it", async () => {
    const closed = await landlord.post(`/api/tickets/${sharedId}/close`, {
      resolution: "Engineer attended, boiler serviced.",
    });
    expect(closed.data.ticket.status).toBe("closed");
    expect(closed.data.ticket.resolution).toContain("serviced");
    expect(closed.data.ticket.closed_by).toBe("Dana W");

    const blocked = await tenant.post(`/api/tickets/${sharedId}/messages`, { body: "one more thing" });
    expect(blocked.status).toBe(400);

    const reopened = await landlord.post(`/api/tickets/${sharedId}/reopen`);
    expect(reopened.data.ticket.status).toBe("open");
    expect(reopened.data.ticket.resolution).toBeNull();
  });

  test("a tenant reopening a bot-closed thread goes back to the bot", async () => {
    const made = await tenant.post("/api/tickets", {
      title: "Disposal dead", description: "garbage disposal is completely dead, no sound",
    });
    const id = made.data.ticket.id;
    await tenant.post(`/api/tickets/${id}/messages`, { body: "yes that fixed it" });
    const reopened = await tenant.post(`/api/tickets/${id}/reopen`);
    expect(reopened.data.ticket.status).toBe("triage");
  });

  test("the property overview is landlord-only", async () => {
    const mine = await landlord.get("/api/property");
    expect(mine.status).toBe(200);
    expect(mine.data.tenants.length).toBeGreaterThan(0);
    expect(mine.data.counts.open).toBeGreaterThan(0);
    const theirs = await tenant.get("/api/property");
    expect(theirs.status).toBe(403);
  });
});

/* ------------------------------------------------------------- read state */

describe("unread tracking", () => {
  test("the other party's messages count as unread until the thread is opened", async () => {
    const made = await landlord.post("/api/tickets", {
      title: "Window seal check", description: "Checking the seals on your windows next week.", tenantId,
    });
    const id = made.data.ticket.id;

    const before = await tenant.get("/api/tickets?status=open");
    expect(before.data.tickets.find((t: any) => t.id === id).unread).toBe(1);

    const opened = await tenant.get(`/api/tickets/${id}`);
    expect(opened.data.lastReadId).toBe(0); // nothing seen yet, so the whole thread is new

    const after = await tenant.get("/api/tickets?status=open");
    expect(after.data.tickets.find((t: any) => t.id === id).unread).toBe(0);
  });

  test("your own messages never show as unread to you", async () => {
    const made = await tenant.post("/api/tickets", {
      title: "Loose tile", description: "A tile by the front door is loose and rocking",
    });
    const list = await tenant.get("/api/tickets?status=all");
    expect(list.data.tickets.find((t: any) => t.id === made.data.ticket.id).unread).toBe(0);
  });
});

/* ------------------------------------------------------------ credentials */

describe("password change", () => {
  test("requires the current password and invalidates other sessions", async () => {
    const username = uniq("pw");
    const a = new Session();
    await a.post("/api/signup", {
      role: "tenant", username, password: "password123",
      displayName: "PW", joinCode, unit: "7C",
    });
    const b = new Session();
    await b.post("/api/login", { username, password: "password123" });
    expect((await b.get("/api/tickets")).status).toBe(200);

    expect((await a.post("/api/password", { currentPassword: "nope", newPassword: "brandnew123" })).status).toBe(403);
    expect((await a.post("/api/password", { currentPassword: "password123", newPassword: "short" })).status).toBe(400);
    expect((await a.post("/api/password", { currentPassword: "password123", newPassword: "brandnew123" })).status).toBe(200);

    expect((await a.get("/api/tickets")).status).toBe(200); // the session that changed it survives
    expect((await b.get("/api/tickets")).status).toBe(401); // every other session does not
    expect((await new Session().post("/api/login", { username, password: "password123" })).status).toBe(401);
    expect((await new Session().post("/api/login", { username, password: "brandnew123" })).status).toBe(200);
  });
});

/* --------------------------------------------- cross-origin front end (Pages) */

describe("bearer tokens", () => {
  // A front end on GitHub Pages cannot use the session cookie: it is
  // third-party to the API's origin. It holds the token and sends it instead.
  let token = "";
  let username = "";

  test("signup and login hand back the session token", async () => {
    username = uniq("bearer");
    const made = await new Session().post("/api/signup", {
      role: "tenant", username, password: "password123",
      displayName: "Bearer B", joinCode, unit: "3C",
    });
    expect(made.data.token).toMatch(/^[0-9a-f]{64}$/);

    const back = await new Session().post("/api/login", { username, password: "password123" });
    expect(back.data.token).toMatch(/^[0-9a-f]{64}$/);
    token = back.data.token;
  });

  test("the token authenticates without any cookie", async () => {
    const res = await fetch(`${BASE}/api/me`, { headers: { authorization: `Bearer ${token}` } });
    const data = (await res.json()) as any;
    expect(data.user?.username).toBe(username);
  });

  test("it works for writes too, and the scheme is case-insensitive", async () => {
    const res = await fetch(`${BASE}/api/tickets`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `bearer ${token}` },
      body: JSON.stringify({ title: "Dripping tap", description: "The bathroom tap drips all night" }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).ticket.status).toBe("triage");
  });

  test("a bogus or empty token is refused", async () => {
    for (const header of [`Bearer ${"0".repeat(64)}`, "Bearer ", "Basic abc"]) {
      const res = await fetch(`${BASE}/api/tickets`, { headers: { authorization: header } });
      expect(res.status).toBe(401);
    }
  });

  test("signing out invalidates the token", async () => {
    await fetch(`${BASE}/api/logout`, {
      method: "POST", headers: { authorization: `Bearer ${token}` },
    });
    const res = await fetch(`${BASE}/api/tickets`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(401);
  });
});

describe("CORS", () => {
  // The suite's server runs with ALLOWED_ORIGINS set to this one origin.
  const ALLOWED = "https://example.github.io";

  test("an allowed origin gets the headers it needs", async () => {
    const res = await fetch(`${BASE}/api/me`, { headers: { origin: ALLOWED } });
    expect(res.headers.get("access-control-allow-origin")).toBe(ALLOWED);
    expect(res.headers.get("vary")).toBe("Origin");
  });

  test("preflight is answered", async () => {
    const res = await fetch(`${BASE}/api/login`, {
      method: "OPTIONS",
      headers: {
        origin: ALLOWED,
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-headers")).toContain("authorization");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });

  test("an origin that is not on the list gets nothing, so the browser blocks it", async () => {
    const res = await fetch(`${BASE}/api/me`, { headers: { origin: "https://not-mine.example" } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

/* ---------------------------------------------------------- access control */

describe("access control", () => {
  test("signed-out requests are refused", async () => {
    expect((await new Session().get("/api/tickets")).status).toBe(401);
    expect((await new Session().get("/api/me")).data.user).toBeNull();
  });

  test("a tenant cannot reach another property's tickets", async () => {
    const mine = await tenant.get("/api/tickets?status=all");
    const id = mine.data.tickets[0].id;
    expect((await other.get(`/api/tickets/${id}`)).status).toBe(404);
  });

  test("signing out kills the session", async () => {
    const s = new Session();
    await s.post("/api/login", { username: "definitely-not-a-user", password: "x" });
    const throwaway = new Session();
    const username = uniq("bye");
    await throwaway.post("/api/signup", {
      role: "tenant", username, password: "password123", displayName: "B", joinCode, unit: "1Z",
    });
    expect((await throwaway.get("/api/tickets")).status).toBe(200);
    await throwaway.post("/api/logout");
    throwaway.cookie = ""; // the browser drops it via Set-Cookie; mimic that
    expect((await throwaway.get("/api/tickets")).status).toBe(401);
  });

  test("static paths cannot escape the public directory", async () => {
    for (const p of ["/../src/db.ts", "/../package.json", "/../../etc/passwd"]) {
      const res = await fetch(BASE + p);
      const body = await res.text();
      expect(body).not.toContain("password_hash");
      expect(body).not.toContain("\"dependencies\"");
    }
  });
});
