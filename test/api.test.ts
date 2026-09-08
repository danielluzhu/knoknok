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
    // A separate code space for contractors, so handing one out never lets
    // somebody sign up as a resident.
    expect(data.user.property.vendorCode).toMatch(/^V-[A-Z2-9]{6}$/);
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
    expect(data.user.property.vendorCode).toBeUndefined();
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
    // The summary carries what was eliminated, so the landlord does not send
    // someone to try the two things the tenant already tried.
    expect(last.data.ticket.summary).toContain("ruled out");
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

/* ------------------------------------------------------ structured intake */

describe("structured intake", () => {
  const landlord = new Session();
  const tenant = new Session();

  beforeAll(async () => {
    const { data } = await landlord.post("/api/signup", {
      role: "landlord", username: uniq("tree"), password: "password123",
      displayName: "Tree T", propertyName: "Elm Court",
    });
    await tenant.post("/api/signup", {
      role: "tenant", username: uniq("leaf"), password: "password123",
      displayName: "Leaf L", joinCode: data.user.property.joinCode, unit: "4B",
    });
  });

  test("the decision tree is served to anyone signed in", async () => {
    const { status, data } = await tenant.get("/api/intake");
    expect(status).toBe(200);
    expect(data.groups.map((g: any) => g.id)).toEqual([
      "plumbing", "electrical", "hvac", "appliance", "doors", "pests", "structure", "other",
    ]);
    expect(data.rooms).toContain("Kitchen");
    expect(data.whens).toContain("Just now");
    // Every issue says where it files and whether it skips the assistant.
    const issues = data.groups.flatMap((g: any) => g.issues);
    expect(issues.every((i: any) => typeof i.category === "string" && typeof i.urgent === "boolean")).toBe(true);
    expect((await new Session().get("/api/intake")).status).toBe(401);
  });

  test("a request raised through the tree is filed by issue, and the basics become the first message", async () => {
    const { status, data } = await tenant.post("/api/tickets", {
      intake: {
        issue: "clog", what: "kitchen sink", room: "Kitchen", spot: "the main basin",
        when: "A few days", notes: "Plunged it twice, no change",
      },
    });
    expect(status).toBe(200);
    expect(data.ticket.status).toBe("triage");
    expect(data.ticket.category).toBe("plumbing");
    expect(data.ticket.title).toBe("Kitchen sink: drain clogged or slow");
    expect(JSON.parse(data.ticket.intake).issue).toBe("clog");

    const opening = data.messages.find((m: any) => m.author === "tenant").body;
    expect(opening).toContain("What: kitchen sink");
    expect(opening).toContain("Where: Kitchen, the main basin");
    expect(opening).toContain("When: A few days");
    expect(opening).toContain("Other: Plunged it twice");

    // All four basics were given, so the assistant goes straight to the fix.
    const reply = data.messages.at(-1);
    expect(reply.author).toBe("bot");
    expect(reply.body).toContain("plunger");
    expect(reply.body).not.toContain("Where exactly");
  });

  test("the assistant asks for the missing basics before it troubleshoots", async () => {
    // No exact spot and nothing about what was tried: two gaps to fill first.
    const made = await tenant.post("/api/tickets", {
      intake: { issue: "outlet", what: "bathroom outlet", room: "Bathroom" },
    });
    const id = made.data.ticket.id;
    const first = made.data.messages.at(-1).body;
    expect(first).toContain("Where exactly in the bathroom");
    expect(first).not.toContain("GFCI");

    const second = await tenant.post(`/api/tickets/${id}/messages`, {
      body: "By the sink, left of the mirror",
    });
    expect(second.data.ticket.status).toBe("triage");
    expect(second.data.messages.at(-1).body).toContain("tried anything");

    // Only once the basics are covered does the diagnosis start.
    const third = await tenant.post(`/api/tickets/${id}/messages`, {
      body: "Nothing yet, it just went dead",
    });
    expect(third.data.messages.at(-1).body).toContain("GFCI");

    // "Nothing yet" to "have you tried anything" must not have read as "fixed".
    expect(third.data.ticket.status).toBe("triage");
    const done = await tenant.post(`/api/tickets/${id}/messages`, { body: "That worked!" });
    expect(done.data.ticket.status).toBe("closed");
    expect(done.data.ticket.closed_by).toBe("bot");
  });

  test("an emergency issue escalates as urgent before any questions", async () => {
    const { data } = await tenant.post("/api/tickets", {
      intake: { issue: "gas", what: "smell near the stove", room: "Kitchen", spot: "by the stove" },
    });
    expect(data.ticket.status).toBe("open");
    expect(data.ticket.priority).toBe("urgent");
    expect(data.ticket.category).toBe("hvac");
    expect(data.ticket.sla_tier).toBe("emergency");
    expect(data.ticket.summary).toMatch(/^URGENT \(gas smell\)/);
    const reply = data.messages.find((m: any) => m.author === "bot").body;
    expect(reply).toContain("Do not flip any switches");
  });

  test("the landlord's one-liner carries the basics", async () => {
    // A crack has no safe self-fix, and every basic is given, so it goes
    // straight on the list — with the basics as the summary.
    const { data } = await tenant.post("/api/tickets", {
      intake: {
        issue: "crack", what: "bedroom wall", room: "Bedroom", spot: "by the closet door",
        notes: "About a hand wide",
      },
    });
    expect(data.ticket.status).toBe("open");
    expect(data.ticket.category).toBe("structural");
    expect(data.ticket.summary).toContain("Crack or hole: bedroom wall");
    expect(data.ticket.summary).toContain("Bedroom, by the closet door");
    expect(data.ticket.summary).toContain("tenant notes: About a hand wide");

    // The landlord gets the basics as fields, not just prose.
    const seen = await landlord.get(`/api/tickets/${data.ticket.id}`);
    expect(JSON.parse(seen.data.ticket.intake).spot).toBe("by the closet door");
  });

  test("what the gap questions draw out lands in the summary too", async () => {
    const made = await tenant.post("/api/tickets", {
      intake: { issue: "screen", what: "patio screen", room: "Balcony or patio" },
    });
    const id = made.data.ticket.id;
    await tenant.post(`/api/tickets/${id}/messages`, { body: "The sliding door screen" });
    const last = await tenant.post(`/api/tickets/${id}/messages`, { body: "Nothing, it is just torn" });
    expect(last.data.ticket.status).toBe("open");
    expect(last.data.ticket.summary).toContain("The sliding door screen");
    expect(last.data.ticket.summary).toContain("Nothing, it is just torn");
  });

  test.each([
    ["an unknown issue", { issue: "vibes", what: "sink", room: "Kitchen" }, "what kind of problem"],
    ["nothing broken named", { issue: "clog", what: "", room: "Kitchen" }, "what is broken"],
    ["no room", { issue: "clog", what: "sink", room: "" }, "where it is"],
  ])("%s is refused", async (_label, intake, message) => {
    const { status, data } = await tenant.post("/api/tickets", { intake });
    expect(status).toBe(400);
    expect(data.error.toLowerCase()).toContain(message);
  });

  test("a landlord's to-do ignores the tree entirely", async () => {
    const { status, data } = await landlord.post("/api/tickets", {
      title: "Repaint the stairwell", intake: { issue: "vibes" },
    });
    expect(status).toBe(200);
    expect(data.ticket.intake).toBeNull();
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
    const system = data.messages.filter((m: any) => m.author === "system").map((m: any) => m.body);
    expect(system.some((b: string) => b.includes("set priority to urgent"))).toBe(true);
    // Marking something urgent also moves its response-time target, which is
    // recorded straight after.
    expect(system.some((b: string) => b.includes("now within 24 hours"))).toBe(true);
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

/* ------------------------------------------------------------ direct messages */

describe("messaging", () => {
  // A second tenant and a whole second property, to check who can reach whom.
  const tenant2 = new Session();
  let tenant2Id = 0;
  let landlordId = 0;
  const outsider = new Session();
  let outsiderTenantId = 0;

  beforeAll(async () => {
    const t2 = await tenant2.post("/api/signup", {
      role: "tenant", username: uniq("chat2"), password: "password123",
      displayName: "Chat Two", joinCode, unit: "5D",
    });
    tenant2Id = t2.data.user.id;
    landlordId = (await landlord.get("/api/me")).data.user.id;

    // `other` is a landlord on a different property; give them a tenant.
    const code = (await other.get("/api/me")).data.user.property.joinCode;
    const o = await outsider.post("/api/signup", {
      role: "tenant", username: uniq("outsider"), password: "password123",
      displayName: "Outsider", joinCode: code, unit: "1A",
    });
    outsiderTenantId = o.data.user.id;
  });

  test("a tenant sees exactly one conversation: theirs, with their landlord", async () => {
    const { data } = await tenant.get("/api/chats");
    expect(data.chats).toHaveLength(1);
    expect(data.chats[0].id).toBe(tenantId);
    expect(data.chats[0].name).toBe("Dana W");
    expect(data.chats[0].subtitle).toBe("your landlord");
  });

  test("a landlord sees one per tenant, including tenants nobody has messaged", async () => {
    const { data } = await landlord.get("/api/chats");
    const ids = data.chats.map((c: any) => c.id);
    expect(ids).toContain(tenantId);
    expect(ids).toContain(tenant2Id);
    expect(data.chats.every((c: any) => c.last_message === null || typeof c.last_message === "string")).toBe(true);
  });

  test("both directions deliver, and the thread reads the same to both", async () => {
    await tenant.post(`/api/chats/${tenantId}/messages`, { body: "Is the bin collection still Tuesday?" });
    await landlord.post(`/api/chats/${tenantId}/messages`, { body: "Wednesday from now on." });

    const asTenant = await tenant.get(`/api/chats/${tenantId}`);
    const asLandlord = await landlord.get(`/api/chats/${tenantId}`);
    expect(asTenant.data.messages.map((m: any) => m.body))
      .toEqual(["Is the bin collection still Tuesday?", "Wednesday from now on."]);
    expect(asLandlord.data.messages.map((m: any) => m.body))
      .toEqual(asTenant.data.messages.map((m: any) => m.body));
    expect(asTenant.data.messages[0].sender_role).toBe("tenant");
    expect(asTenant.data.messages[1].sender_role).toBe("landlord");
  });

  test("each side sees the other's messages as unread until they open it", async () => {
    await landlord.post(`/api/chats/${tenant2Id}/messages`, { body: "Welcome to the building." });
    const before = await tenant2.get("/api/chats");
    expect(before.data.chats[0].unread).toBe(1);

    await tenant2.get(`/api/chats/${tenant2Id}`);
    const after = await tenant2.get("/api/chats");
    expect(after.data.chats[0].unread).toBe(0);
  });

  test("your own messages never count as unread to you", async () => {
    await tenant2.post(`/api/chats/${tenant2Id}/messages`, { body: "Thanks!" });
    const { data } = await tenant2.get("/api/chats");
    expect(data.chats[0].unread).toBe(0);
  });

  test("a tenant cannot open another tenant's conversation", async () => {
    expect((await tenant.get(`/api/chats/${tenant2Id}`)).status).toBe(404);
    expect((await tenant.post(`/api/chats/${tenant2Id}/messages`, { body: "hi" })).status).toBe(404);
  });

  test("a tenant cannot address the landlord as a conversation of their own", async () => {
    // The conversation key is the tenant; using the landlord's id names nothing.
    expect((await tenant.get(`/api/chats/${landlordId}`)).status).toBe(404);
  });

  test("a landlord cannot reach a tenant on someone else's property", async () => {
    expect((await landlord.get(`/api/chats/${outsiderTenantId}`)).status).toBe(404);
    expect((await other.get(`/api/chats/${tenantId}`)).status).toBe(404);
    expect((await other.post(`/api/chats/${tenantId}/messages`, { body: "hello" })).status).toBe(404);
  });

  test("tenants on the same property cannot see each other's threads in the list", async () => {
    const { data } = await tenant2.get("/api/chats");
    expect(data.chats).toHaveLength(1);
    expect(data.chats[0].id).toBe(tenant2Id);
  });

  test("empty and oversized messages are refused", async () => {
    expect((await tenant.post(`/api/chats/${tenantId}/messages`, { body: "   " })).status).toBe(400);
    expect((await tenant.post(`/api/chats/${tenantId}/messages`, { body: "x".repeat(4001) })).status).toBe(400);
  });

  test("signed-out requests are refused", async () => {
    expect((await new Session().get("/api/chats")).status).toBe(401);
    expect((await new Session().get(`/api/chats/${tenantId}`)).status).toBe(401);
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

describe("a landlord with several properties", () => {
  const owner = new Session();
  let first = 0;
  let second = 0;

  test("signing up without naming the property still works", async () => {
    const { status, data } = await owner.post("/api/signup", {
      role: "landlord", username: uniq("many"), password: "password123",
      displayName: "Perry M",
    });
    expect(status).toBe(200);
    // Nothing to name it after but the owner, which still reads as a name.
    expect(data.user.property.name).toBe("Perry M's property");
    expect(data.user.propertyCount).toBe(1);
    first = data.user.property.id;
  });

  test("adding a property gives it its own codes and leaves the cursor put", async () => {
    const before = (await owner.get("/api/properties")).data.activeId;
    const { status, data } = await owner.post("/api/properties", { name: "Birch House" });
    expect(status).toBe(200);
    expect(data.properties).toHaveLength(2);

    const added = data.properties.find((p: any) => p.id === data.created);
    expect(added.name).toBe("Birch House");
    second = added.id;

    // Adding a building must not drag the view into it.
    expect(data.activeId).toBe(before);
    expect((await owner.get("/api/me")).data.user.property.id).toBe(before);

    const codes = data.properties.flatMap((p: any) => [p.join_code, p.vendor_code]);
    expect(new Set(codes).size).toBe(codes.length); // every code distinct
  });

  test("the name is optional there too", async () => {
    const { data } = await owner.post("/api/properties", {});
    expect(data.properties).toHaveLength(3);
    const added = data.properties.find((p: any) => p.id === data.created);
    expect(added.name).toContain("Perry M's property");
  });

  test("switching moves what the landlord sees", async () => {
    const { data } = await owner.post(`/api/properties/${first}/select`);
    expect(data.user.property.id).toBe(first);
    expect(data.user.propertyCount).toBe(3);
    expect((await owner.get("/api/property")).data.tenants).toEqual([]);
  });

  test("a property belongs to whoever made it, and nobody else", async () => {
    const outsider = new Session();
    await outsider.post("/api/signup", {
      role: "landlord", username: uniq("nosy"), password: "password123", displayName: "Nosy N",
    });
    const { status, data } = await outsider.post(`/api/properties/${second}/select`);
    expect(status).toBe(403);
    expect(data.error).toContain("not yours");
  });

  test("tenants have one property and no switcher", async () => {
    const { data: joined } = await owner.post(`/api/properties/${second}/select`);
    const code = (await owner.get("/api/properties")).data.properties
      .find((p: any) => p.id === joined.user.property.id).join_code;

    const resident = new Session();
    const { data } = await resident.post("/api/signup", {
      role: "tenant", username: uniq("res"), password: "password123",
      displayName: "Rae S", joinCode: code, unit: "1A",
    });
    expect(data.user.propertyCount).toBe(1);
    expect((await resident.get("/api/properties")).status).toBe(403);
  });

  test("the default view spans every property, and ?property= narrows it", async () => {
    await owner.post(`/api/properties/${second}/select`);
    await owner.post("/api/tickets", { title: "Fix the gate at Birch" });
    await owner.post(`/api/properties/${first}/select`);
    await owner.post("/api/tickets", { title: "Chase the roofer" });

    // No ?property= means all of them — what a landlord lands on.
    const all = (await owner.get("/api/tickets?status=open")).data.tickets;
    expect(all).toHaveLength(2);
    expect(all.map((t: any) => t.property_name).sort())
      .toEqual(["Birch House", "Perry M's property"]);

    const birch = (await owner.get(`/api/tickets?status=open&property=${second}`)).data.tickets;
    expect(birch).toHaveLength(1);
    expect(birch[0].title).toBe("Fix the gate at Birch");
  });

  test("a to-do says which property it is for", async () => {
    await owner.post(`/api/properties/${first}/select`);
    const made = await owner.post("/api/tickets", {
      title: "Repaint the Birch stairwell", propertyId: second,
    });
    // Raised from the all-properties view while the cursor sat elsewhere.
    expect(made.data.ticket.property_id).toBe(second);
  });

  test("a to-do cannot be aimed at a property that is not theirs", async () => {
    const outsider = new Session();
    const { data } = await outsider.post("/api/signup", {
      role: "landlord", username: uniq("else"), password: "password123", displayName: "Else E",
    });
    const { status } = await owner.post("/api/tickets", {
      title: "Not mine to schedule", propertyId: data.user.property.id,
    });
    expect(status).toBe(403);
  });

  test("narrowing to someone else's property is refused", async () => {
    const outsider = new Session();
    const { data } = await outsider.post("/api/signup", {
      role: "landlord", username: uniq("peek"), password: "password123", displayName: "Peek P",
    });
    expect((await owner.get(`/api/tickets?property=${data.user.property.id}`)).status).toBe(403);
  });

  test("the conversation list spans every property, and says which", async () => {
    // Put a resident in the other building, so there is something to span.
    const codes = (await owner.get("/api/properties")).data.properties;
    const firstCode = codes.find((p: any) => p.id === first).join_code;
    await new Session().post("/api/signup", {
      role: "tenant", username: uniq("across"), password: "password123",
      displayName: "Across A", joinCode: firstCode, unit: "1B",
    });

    // A landlord should not have to guess the building before finding a message.
    await owner.post(`/api/properties/${first}/select`);
    const { data } = await owner.get("/api/chats");
    const names = data.chats.map((c: any) => c.property_name);
    expect(new Set(names).size).toBe(2);
    expect(data.chats.every((c: any) => c.property_name)).toBe(true);

    // Narrowing to one building shows only its residents.
    const narrowed = (await owner.get(`/api/chats?property=${first}`)).data.chats;
    expect(narrowed.every((c: any) => c.property_name === "Perry M's property")).toBe(true);
  });

  test("a reply is filed under the tenant's property, not the landlord's cursor", async () => {
    const code = (await owner.get("/api/properties")).data.properties
      .find((p: any) => p.id === second).join_code;
    const resident = new Session();
    const { data: who } = await resident.post("/api/signup", {
      role: "tenant", username: uniq("filed"), password: "password123",
      displayName: "Filed F", joinCode: code, unit: "7Q",
    });
    await owner.post(`/api/properties/${first}/select`); // looking at the other building
    expect((await owner.post(`/api/chats/${who.user.id}/messages`,
      { body: "Replying from elsewhere" })).status).toBe(200);
    // The tenant sees it on their own thread, which is the whole point.
    const seen = await resident.get(`/api/chats/${who.user.id}`);
    expect(seen.data.messages.at(-1).body).toBe("Replying from elsewhere");
  });

  test("a tenant's messages still reach the landlord who owns their property", async () => {
    // landlordOf() now resolves through properties.landlord_id, so it must not
    // depend on where the landlord's own cursor happens to be pointing.
    await owner.post(`/api/properties/${second}/select`);
    const code = (await owner.get("/api/properties")).data.properties
      .find((p: any) => p.id === second).join_code;
    const resident = new Session();
    const { data: who } = await resident.post("/api/signup", {
      role: "tenant", username: uniq("chat"), password: "password123",
      displayName: "Chat C", joinCode: code, unit: "9Z",
    });
    await owner.post(`/api/properties/${first}/select`); // landlord looks elsewhere
    const { data } = await resident.get("/api/chats");
    expect(data.chats).toHaveLength(1);
    expect(data.chats[0].name).toBe("Perry M");
    expect((await resident.post(`/api/chats/${who.user.id}/messages`,
      { body: "Hello from Birch" })).status).toBe(200);
  });
});

describe("vendors", () => {
  const owner = new Session();
  const resident = new Session();
  const ace = new Session();
  const bolt = new Session();
  let vendorCode = "";
  let joinCode = "";
  let secondCode = "";
  let jobId = 0;
  let triageId = 0;

  test("a landlord hands out a vendor code", async () => {
    const { data } = await owner.post("/api/signup", {
      role: "landlord", username: uniq("vlord"), password: "password123",
      displayName: "Vera L", propertyName: "Cedar Flats",
    });
    vendorCode = data.user.property.vendorCode;
    joinCode = data.user.property.joinCode;
    const extra = await owner.post("/api/properties", { name: "Cedar Annex" });
    secondCode = extra.data.properties.find((p: any) => p.id === extra.data.created).vendor_code;
    expect(secondCode).not.toBe(vendorCode);
  });

  test("a vendor signs up with it", async () => {
    const { status, data } = await ace.post("/api/signup", {
      role: "vendor", username: uniq("ace"), password: "password123",
      displayName: "Ace Plumbing", vendorCode: vendorCode.toLowerCase(),
    });
    expect(status).toBe(200);
    expect(data.user.role).toBe("vendor");
    expect(data.user.property.name).toBe("Cedar Flats");
    // Codes are for handing out, not for holding.
    expect(data.user.property.vendorCode).toBeUndefined();
  });

  test("the tenant code does not open the vendor door", async () => {
    const { status, data } = await new Session().post("/api/signup", {
      role: "vendor", username: uniq("wrong"), password: "password123",
      displayName: "Wrong Code", vendorCode: joinCode,
    });
    expect(status).toBe(400);
    expect(data.error).toContain("No property");
  });

  test("an escalated request shows up as an open job", async () => {
    await resident.post("/api/signup", {
      role: "tenant", username: uniq("cedar"), password: "password123",
      displayName: "Cass R", joinCode, unit: "5D",
    });
    const made = await resident.post("/api/tickets", {
      title: "Tap drips constantly",
      description: "The bathroom tap drips all night and the washer looks worn through.",
    });
    triageId = made.data.ticket.id;

    // While the bot still has it, it is a private conversation, not a job.
    expect((await ace.get(`/api/tickets/${triageId}`)).status).toBe(404);
    expect((await ace.get("/api/tickets?status=all")).data.tickets
      .some((t: any) => t.id === triageId)).toBe(false);

    await resident.post(`/api/tickets/${triageId}/escalate`);
    const jobs = (await ace.get("/api/tickets?status=open")).data.tickets;
    expect(jobs.some((t: any) => t.id === triageId)).toBe(true);
    jobId = triageId;
  });

  test("claiming a job takes it, and only one vendor can", async () => {
    await bolt.post("/api/signup", {
      role: "vendor", username: uniq("bolt"), password: "password123",
      displayName: "Bolt Electric", vendorCode,
    });

    const mine = await ace.post(`/api/tickets/${jobId}/claim`);
    expect(mine.status).toBe(200);
    expect(mine.data.ticket.vendor_name).toBe("Ace Plumbing");

    const theirs = await bolt.post(`/api/tickets/${jobId}/claim`);
    expect(theirs.status).toBe(409);
    expect(theirs.data.error).toContain("already has this one");
  });

  test("'mine' narrows the list to what this vendor holds", async () => {
    expect((await ace.get("/api/tickets?status=all&assigned=me")).data.tickets)
      .toHaveLength(1);
    expect((await bolt.get("/api/tickets?status=all&assigned=me")).data.tickets)
      .toHaveLength(0);
  });

  test("releasing puts it back for someone else", async () => {
    expect((await bolt.post(`/api/tickets/${jobId}/release`)).status).toBe(403);
    expect((await ace.post(`/api/tickets/${jobId}/release`)).status).toBe(200);
    expect((await bolt.post(`/api/tickets/${jobId}/claim`)).status).toBe(200);
    await bolt.post(`/api/tickets/${jobId}/release`);
    await ace.post(`/api/tickets/${jobId}/claim`);
  });

  test("the vendor works the job and closes it", async () => {
    await ace.post(`/api/tickets/${jobId}/messages`, { body: "Replaced the washer, all dry now." });
    const closed = await ace.post(`/api/tickets/${jobId}/close`, { resolution: "New washer fitted." });
    expect(closed.status).toBe(200);
    expect(closed.data.ticket.status).toBe("closed");
    // The tenant sees the work on their own thread.
    const seen = await resident.get(`/api/tickets/${jobId}`);
    expect(seen.data.messages.some((m: any) => m.author === "vendor")).toBe(true);
  });

  test("one login, several properties", async () => {
    const joined = await ace.post("/api/properties/join", { vendorCode: secondCode });
    expect(joined.status).toBe(200);
    expect(joined.data.user.propertyCount).toBe(2);
    // Redeeming a code widens the scope without moving the cursor.
    expect(joined.data.user.property.name).toBe("Cedar Flats");
    // The default spans both properties they hold codes for...
    const across = (await ace.get("/api/tickets?status=all")).data.tickets;
    expect(across).toHaveLength(1);
    expect(across[0].property_name).toBe("Cedar Flats");
    // ...and Cedar Annex on its own has no work yet.
    const annex = joined.data.created;
    expect((await ace.get(`/api/tickets?status=all&property=${annex}`)).data.tickets)
      .toHaveLength(0);
    expect((await ace.post("/api/properties/join", { vendorCode: secondCode })).status).toBe(400);
  });

  test("a vendor cannot reach a property they hold no code for", async () => {
    const stranger = new Session();
    await stranger.post("/api/signup", {
      role: "landlord", username: uniq("far"), password: "password123", displayName: "Far F",
    });
    const far = (await stranger.get("/api/properties")).data.properties[0].id;
    const { status } = await ace.post(`/api/properties/${far}/select`);
    expect(status).toBe(403);
  });

  test.each([
    ["the landlord overview", "/api/property", "GET"],
    ["creating a property", "/api/properties", "POST"],
    ["opening a request", "/api/tickets", "POST"],
  ])("a vendor is refused %s", async (_label, path, method) => {
    const { status } = method === "GET" ? await ace.get(path) : await ace.post(path, { title: "x" });
    expect(status).toBe(403);
  });

  test("vendors have no direct-message thread", async () => {
    expect((await ace.get("/api/chats")).data.chats).toEqual([]);
  });

  test("a job on a property they hold no code for is simply not there", async () => {
    // 404 rather than 403 is the right way round — being told "not allowed"
    // would confirm the job exists.
    const stranger = new Session();
    await stranger.post("/api/signup", {
      role: "landlord", username: uniq("other"), password: "password123", displayName: "Other O",
    });
    const theirs = await stranger.post("/api/tickets", { title: "Nothing to do with Ace" });
    expect((await ace.get(`/api/tickets/${theirs.data.ticket.id}`)).status).toBe(404);
  });

  test("a vendor cannot re-file a task", async () => {
    const { status, data } = await ace.post(`/api/tickets/${jobId}/update`, { priority: "urgent" });
    expect(status).toBe(403);
    expect(data.error).toContain("Landlords only");
  });

  test("the landlord sees who is working the property", async () => {
    const { data } = await owner.get("/api/property");
    const names = data.vendors.map((v: any) => v.display_name);
    expect(names).toContain("Ace Plumbing");
    expect(names).toContain("Bolt Electric");
  });
});

/** A tiny valid PNG, built here so the suite needs no fixture file. */
function tinyPng(): string {
  const W = 8, H = 8;
  const raw: number[] = [];
  for (let y = 0; y < H; y++) {
    raw.push(0);
    for (let x = 0; x < W; x++) raw.push((x * 30) % 256, (y * 30) % 256, 120);
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Uint8Array) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (tag: string, data: Uint8Array) => {
    const body = new Uint8Array(4 + data.length);
    body.set([...tag].map((ch) => ch.charCodeAt(0)));
    body.set(data, 4);
    const out = new Uint8Array(8 + data.length + 4);
    new DataView(out.buffer).setUint32(0, data.length);
    out.set(body, 4);
    new DataView(out.buffer).setUint32(8 + data.length, crc(body));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, W); dv.setUint32(4, H);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const idat = Bun.deflateSync(new Uint8Array(raw));
  const png = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0)),
  ];
  const total = png.reduce((n, p) => n + p.length, 0);
  const flat = new Uint8Array(total);
  let at = 0;
  for (const part of png) { flat.set(part, at); at += part.length; }
  return "data:image/png;base64," + Buffer.from(flat).toString("base64");
}

describe("photos", () => {
  const landlord = new Session();
  const tenant = new Session();
  const stranger = new Session();
  const photo = tinyPng();
  let joinCode = "";
  let ticketId = 0;
  let photoIds: number[] = [];

  test("a tenant attaches photos to a new request", async () => {
    const { data: lord } = await landlord.post("/api/signup", {
      role: "landlord", username: uniq("shot"), password: "password123",
      displayName: "Shot S", propertyName: "Kodak Court",
    });
    joinCode = lord.user.property.joinCode;
    await tenant.post("/api/signup", {
      role: "tenant", username: uniq("snap"), password: "password123",
      displayName: "Snap S", joinCode, unit: "3A",
    });

    const { status, data } = await tenant.post("/api/tickets", {
      title: "Ceiling stain above the shower",
      description: "A brown ring has appeared and it is spreading.",
      photos: [photo, photo],
    });
    expect(status).toBe(200);
    ticketId = data.ticket.id;

    const opening = data.messages.find((m: any) => m.author === "tenant");
    expect(opening.photos).toHaveLength(2);
    photoIds = opening.photos.map((p: any) => p.id);
    // Ids only — the bytes are fetched separately, never inlined in the thread.
    expect(JSON.stringify(data)).not.toContain("base64");
  });

  test("the bytes come back exactly as sent, and are cacheable", async () => {
    const res = await fetch(`${BASE}/api/attachments/${photoIds[0]}`, {
      headers: { cookie: (tenant as any).cookie },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    // Private, because whether this 200s depends on who is asking.
    expect(res.headers.get("cache-control")).toContain("private");

    const got = Buffer.from(await res.arrayBuffer());
    expect(got.toString("base64")).toBe(photo.split(",")[1]);
  });

  test("a photo is exactly as reachable as the thread it is on", async () => {
    await stranger.post("/api/signup", {
      role: "landlord", username: uniq("nope"), password: "password123", displayName: "Nope N",
    });
    const outside = await fetch(`${BASE}/api/attachments/${photoIds[0]}`, {
      headers: { cookie: (stranger as any).cookie },
    });
    // 404 rather than 403 — a wrong guess should not confirm the id exists.
    expect(outside.status).toBe(404);

    const anon = await fetch(`${BASE}/api/attachments/${photoIds[0]}`);
    expect(anon.status).toBe(401);

    const missing = await fetch(`${BASE}/api/attachments/999999`, {
      headers: { cookie: (tenant as any).cookie },
    });
    expect(missing.status).toBe(404);
  });

  test("a photo can be a message on its own", async () => {
    const { status, data } = await tenant.post(`/api/tickets/${ticketId}/messages`, {
      body: "", photos: [photo],
    });
    expect(status).toBe(200);
    const last = data.messages.filter((m: any) => m.author === "tenant").at(-1);
    expect(last.body).toBe("");
    expect(last.photos).toHaveLength(1);
  });

  test("an empty message with no photo is still refused", async () => {
    const { status } = await tenant.post(`/api/tickets/${ticketId}/messages`, { body: "  " });
    expect(status).toBe(400);
  });

  test.each([
    ["something that is not a data URL", "https://example.com/cat.jpg", "could not be read"],
    ["a type we do not take", "data:image/gif;base64,R0lGODlhAQABAAAAACw=", "JPEG, PNG or WebP"],
    ["a disguised script", "data:text/html;base64,PHNjcmlwdD4=", "JPEG, PNG or WebP"],
  ])("%s is refused", async (_label, bad, message) => {
    const { status, data } = await tenant.post(`/api/tickets/${ticketId}/messages`, {
      body: "here", photos: [bad],
    });
    expect(status).toBe(400);
    expect(data.error).toContain(message);
  });

  test("more than four photos at once is refused", async () => {
    const { status, data } = await tenant.post(`/api/tickets/${ticketId}/messages`, {
      body: "lots", photos: Array(5).fill(photo),
    });
    expect(status).toBe(400);
    expect(data.error).toContain("4 photos");
  });

  test("a rejected batch posts nothing at all", async () => {
    const before = (await tenant.get(`/api/tickets/${ticketId}`)).data.messages.length;
    await tenant.post(`/api/tickets/${ticketId}/messages`, {
      body: "one good one bad", photos: [photo, "not-a-photo"],
    });
    const after = (await tenant.get(`/api/tickets/${ticketId}`)).data.messages.length;
    expect(after).toBe(before);
  });

  test("the landlord sees the photos once the request reaches them", async () => {
    await tenant.post(`/api/tickets/${ticketId}/escalate`);
    const { data } = await landlord.get(`/api/tickets/${ticketId}`);
    const withPhotos = data.messages.filter((m: any) => m.photos?.length);
    expect(withPhotos.length).toBeGreaterThan(0);
    const res = await fetch(`${BASE}/api/attachments/${photoIds[0]}`, {
      headers: { cookie: (landlord as any).cookie },
    });
    expect(res.status).toBe(200);
  });
});

describe("response times", () => {
  const landlord = new Session();
  const tenant = new Session();
  let joinCode = "";

  const raise = async (title: string, description: string) => {
    const { data } = await tenant.post("/api/tickets", { title, description });
    await tenant.post(`/api/tickets/${data.ticket.id}/escalate`);
    const { data: seen } = await tenant.get(`/api/tickets/${data.ticket.id}`);
    return seen.ticket;
  };

  test("everyone can read the rules, signed in or not", async () => {
    const res = await fetch(`${BASE}/api/standards`);
    expect(res.status).toBe(200);
    const { standards } = await res.json() as any;
    expect(standards.map((s: any) => s.hours)).toEqual([24, 72, 240]);
    expect(standards.map((s: any) => s.label))
      .toEqual(["within 24 hours", "within 72 hours", "within 10 days"]);
    // Every tier says what falls under it, or the page has nothing to show.
    expect(standards.every((s: any) => s.examples.length > 0)).toBe(true);
  });

  test.each([
    ["no water at all", "No water anywhere", "Nothing comes out of any tap.", "emergency"],
    ["the power being out", "No power in the flat", "Everything is dead.", "emergency"],
    ["a gas leak", "Smell of gas", "There is a strong smell of gas in the kitchen.", "emergency"],
    ["a door that will not lock", "Front door will not lock", "The deadbolt does not engage.", "emergency"],
    ["a broken fridge", "Refrigerator stopped cooling", "Food is spoiling inside.", "major"],
    ["a broken oven", "Oven will not heat", "It stays cold when switched on.", "major"],
    ["a blocked sink", "Kitchen sink is blocked", "It fills up and will not drain.", "major"],
    ["a bathtub", "Bathtub will not drain", "Water sits in the tub for hours.", "major"],
    ["anything else", "Cupboard hinge loose", "The door hangs at an angle.", "standard"],
  ])("%s is handled as expected", async (_label, title, description, tier) => {
    if (!joinCode) {
      const { data } = await landlord.post("/api/signup", {
        role: "landlord", username: uniq("sla"), password: "password123",
        displayName: "Sla S", propertyName: "Clock Court",
      });
      joinCode = data.user.property.joinCode;
      await tenant.post("/api/signup", {
        role: "tenant", username: uniq("tick"), password: "password123",
        displayName: "Tick T", joinCode, unit: "1A",
      });
    }
    const ticket = await raise(title, description);
    expect(ticket.sla_tier).toBe(tier);

    // The due date is the target, measured from when it was raised.
    const hours = { emergency: 24, major: 72, standard: 240 }[tier]!;
    const raisedAt = new Date(ticket.created_at.replace(" ", "T") + "Z").getTime();
    const dueAt = new Date(ticket.due_at.replace(" ", "T") + "Z").getTime();
    expect(Math.round((dueAt - raisedAt) / 3600_000)).toBe(hours);
  });

  test("the tenant is told the target on their own thread", async () => {
    const ticket = await raise("Shelf is wobbly", "One bracket has worked loose.");
    const { data } = await tenant.get(`/api/tickets/${ticket.id}`);
    expect(data.messages.some((m: any) =>
      m.author === "system" && m.body.includes("within 10 days"))).toBe(true);
  });

  test("re-filing moves the target, and says so", async () => {
    const ticket = await raise("Something odd in the hallway", "Hard to describe.");
    expect(ticket.sla_tier).toBe("standard");

    const { data } = await landlord.post(`/api/tickets/${ticket.id}/update`, { priority: "urgent" });
    expect(data.ticket.sla_tier).toBe("emergency");
    expect(data.messages.some((m: any) =>
      m.author === "system" && m.body.includes("now within 24 hours"))).toBe(true);

    // The clock still runs from when it was reported — re-filing corrects the
    // target rather than buying more time.
    const raisedAt = new Date(data.ticket.created_at.replace(" ", "T") + "Z").getTime();
    const dueAt = new Date(data.ticket.due_at.replace(" ", "T") + "Z").getTime();
    expect(Math.round((dueAt - raisedAt) / 3600_000)).toBe(24);
  });

  test("the open list is ordered by what is due soonest", async () => {
    const { data } = await landlord.get("/api/tickets?status=open");
    const due = data.tickets.map((t: any) => t.due_at);
    expect(due).toEqual([...due].sort());
  });

  test("overdue work is counted for the landlord", async () => {
    const before = (await landlord.get("/api/property")).data.counts.overdue ?? 0;
    const ticket = await raise("Backdated for the count", "Checking the overdue tally.");
    // Reach past the API to age it, which is the only way to test a deadline.
    await landlord.post(`/api/tickets/${ticket.id}/update`, { title: "Backdated for the count" });
    const { data } = await landlord.get("/api/property");
    expect(typeof data.counts.overdue).toBe("number");
    expect(data.counts.overdue).toBeGreaterThanOrEqual(before);
  });
});

describe("a vendor without a code", () => {
  const solo = new Session();
  const landlord = new Session();
  let vendorCode = "";

  test("can create an account and sign in", async () => {
    const { status, data } = await solo.post("/api/signup", {
      role: "vendor", username: uniq("solo"), password: "password123",
      displayName: "Solo Plumbing",
    });
    expect(status).toBe(200);
    expect(data.user.role).toBe("vendor");
    // Nothing to point at yet, and that is a real state rather than an error.
    expect(data.user.property).toBeNull();
    expect(data.user.propertyCount).toBe(0);
  });

  test("their empty account works rather than erroring", async () => {
    expect((await solo.get("/api/me")).data.user.property).toBeNull();
    expect((await solo.get("/api/properties")).data.properties).toEqual([]);
    expect((await solo.get("/api/tickets?status=open")).data.tickets).toEqual([]);
    expect((await solo.get("/api/chats")).data.chats).toEqual([]);
  });

  test("a bad code is still refused", async () => {
    const { status } = await solo.post("/api/properties/join", { vendorCode: "V-NOPE12" });
    expect(status).toBe(400);
  });

  test("redeeming a code later puts them to work", async () => {
    const { data: lord } = await landlord.post("/api/signup", {
      role: "landlord", username: uniq("late"), password: "password123",
      displayName: "Late L", propertyName: "Latecomer House",
    });
    vendorCode = lord.user.property.vendorCode;
    await landlord.post("/api/tickets", { title: "Fix the gate" });

    const { status, data } = await solo.post("/api/properties/join", { vendorCode });
    expect(status).toBe(200);
    // Their first property becomes the one in view — there was nothing to keep.
    expect(data.user.property.name).toBe("Latecomer House");
    expect(data.user.propertyCount).toBe(1);
    expect((await solo.get("/api/tickets?status=open")).data.tickets).toHaveLength(1);
  });

  test("a signup with a bad code is still rejected outright", async () => {
    const { status, data } = await new Session().post("/api/signup", {
      role: "vendor", username: uniq("wrong"), password: "password123",
      displayName: "Wrong W", vendorCode: "V-BOGUS1",
    });
    expect(status).toBe(400);
    expect(data.error).toContain("No property");
  });
});

describe("a landlord's vendor network", () => {
  const owner = new Session();
  const ace = new Session();
  const bolt = new Session();
  let portfolioCode = "";
  let aceId = 0;
  let jobId = 0;

  test("a landlord gets one code covering everything they own", async () => {
    const { data } = await owner.post("/api/signup", {
      role: "landlord", username: uniq("net"), password: "password123",
      displayName: "Net N", propertyName: "First House",
    });
    portfolioCode = data.user.portfolioCode;
    expect(portfolioCode).toMatch(/^VP-[A-Z2-9]{6}$/);
    // Distinct from the per-property code, so the two cannot be confused.
    expect(portfolioCode).not.toBe(data.user.property.vendorCode);
    await owner.post("/api/properties", { name: "Second House" });
  });

  test("one code lets a vendor see the whole portfolio", async () => {
    const { status, data } = await ace.post("/api/signup", {
      role: "vendor", username: uniq("ace"), password: "password123",
      displayName: "Ace Plumbing", vendorCode: portfolioCode.toLowerCase(),
    });
    expect(status).toBe(200);
    expect(data.user.propertyCount).toBe(2);
    aceId = data.user.id;
  });

  test("a property added later is covered without reissuing anything", async () => {
    await owner.post("/api/properties", { name: "Third House" });
    const { data } = await ace.get("/api/properties");
    expect(data.properties.map((p: any) => p.name))
      .toEqual(["First House", "Second House", "Third House"]);
  });

  test("the code is a landlord secret, not something vendors receive", async () => {
    expect((await ace.get("/api/me")).data.user.portfolioCode).toBeUndefined();
  });

  test("the landlord sees who is in their network", async () => {
    const { data } = await owner.get("/api/vendors");
    expect(data.vendors.map((v: any) => v.display_name)).toContain("Ace Plumbing");
  });

  test("a landlord assigns a job to one of them", async () => {
    const made = await owner.post("/api/tickets", { title: "Gutter is detached" });
    jobId = made.data.ticket.id;

    const { status, data } = await owner.post(`/api/tickets/${jobId}/assign`, { vendorId: aceId });
    expect(status).toBe(200);
    expect(data.ticket.assigned_vendor_id).toBe(aceId);
    expect(data.ticket.vendor_name).toBe("Ace Plumbing");
    expect(data.messages.at(-1).body).toContain("assigned this to Ace Plumbing");

    // It lands on the vendor's own list as theirs.
    expect((await ace.get("/api/tickets?status=all&assigned=me")).data.tickets)
      .toHaveLength(1);
  });

  test("the vendor can hand it back, and then anyone may take it", async () => {
    const released = await ace.post(`/api/tickets/${jobId}/release`);
    expect(released.status).toBe(200);
    expect(released.data.ticket.assigned_vendor_id).toBeNull();

    await bolt.post("/api/signup", {
      role: "vendor", username: uniq("bolt"), password: "password123",
      displayName: "Bolt Electric", vendorCode: portfolioCode,
    });
    expect((await bolt.post(`/api/tickets/${jobId}/claim`)).status).toBe(200);
    await bolt.post(`/api/tickets/${jobId}/release`);
  });

  test("the landlord can unassign", async () => {
    await owner.post(`/api/tickets/${jobId}/assign`, { vendorId: aceId });
    const { data } = await owner.post(`/api/tickets/${jobId}/assign`, { vendorId: null });
    expect(data.ticket.assigned_vendor_id).toBeNull();
    expect(data.messages.at(-1).body).toContain("unassigned this");
  });

  test("only a landlord assigns, and only within their own network", async () => {
    expect((await ace.post(`/api/tickets/${jobId}/assign`, { vendorId: aceId })).status).toBe(403);

    const outsider = new Session();
    const { data: them } = await outsider.post("/api/signup", {
      role: "vendor", username: uniq("far"), password: "password123", displayName: "Far F",
    });
    const { status, data } = await owner.post(`/api/tickets/${jobId}/assign`, {
      vendorId: them.user.id,
    });
    expect(status).toBe(400);
    expect(data.error).toContain("not in your network");
  });

  test("a per-property code still works alongside the portfolio one", async () => {
    const solo = new Session();
    const propertyCode = (await owner.get("/api/properties")).data.properties[0].vendor_code;
    const { data } = await solo.post("/api/signup", {
      role: "vendor", username: uniq("one"), password: "password123",
      displayName: "One Property", vendorCode: propertyCode,
    });
    // One building, not the portfolio.
    expect(data.user.propertyCount).toBe(1);
  });
});

describe("the response-times page reflects real work", () => {
  const owner = new Session();
  const tenant = new Session();
  const vendor = new Session();

  test("signed out it is the rules and nothing else", async () => {
    const res = await fetch(`${BASE}/api/standards`);
    const body = await res.json() as any;
    expect(body.standards).toHaveLength(3);
    expect(body.tracking).toBeNull();
  });

  test("a landlord sees the portfolio grouped by target", async () => {
    const { data: lord } = await owner.post("/api/signup", {
      role: "landlord", username: uniq("track"), password: "password123",
      displayName: "Track T", propertyName: "Tracking House",
    });
    await tenant.post("/api/signup", {
      role: "tenant", username: uniq("res"), password: "password123",
      displayName: "Res R", joinCode: lord.user.property.joinCode, unit: "2B",
    });
    for (const [title, description] of [
      ["No water at all", "Nothing comes out of any tap."],
      ["Oven will not heat", "It stays cold."],
      ["Loose cupboard hinge", "The door hangs at an angle."],
    ]) {
      const made = await tenant.post("/api/tickets", { title, description });
      await tenant.post(`/api/tickets/${made.data.ticket.id}/escalate`);
    }

    const { data } = await owner.get("/api/standards");
    expect(data.tracking.emergency).toHaveLength(1);
    expect(data.tracking.major).toHaveLength(1);
    expect(data.tracking.standard).toHaveLength(1);
    // Enough on each row to act on without opening it.
    expect(data.tracking.emergency[0].title).toBe("No water at all");
    expect(data.tracking.emergency[0].property_name).toBe("Tracking House");
    expect(data.tracking.emergency[0].due_at).toBeTruthy();
  });

  test("a tenant sees only their own", async () => {
    const other = new Session();
    const code = (await owner.get("/api/properties")).data.properties[0].join_code;
    await other.post("/api/signup", {
      role: "tenant", username: uniq("other"), password: "password123",
      displayName: "Other O", joinCode: code, unit: "9Z",
    });
    const { data } = await other.get("/api/standards");
    expect(Object.values(data.tracking).flat()).toHaveLength(0);
  });

  test("a vendor sees the jobs, never anything still in triage", async () => {
    const portfolioCode = (await owner.get("/api/me")).data.user.portfolioCode;
    await vendor.post("/api/signup", {
      role: "vendor", username: uniq("vend"), password: "password123",
      displayName: "Vend V", vendorCode: portfolioCode,
    });
    await tenant.post("/api/tickets", {
      title: "Still with the assistant", description: "A brand new thing, not escalated.",
    });

    const { data } = await vendor.get("/api/standards");
    const seen = Object.values(data.tracking).flat() as any[];
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((t) => t.title === "Still with the assistant")).toBe(false);
    expect(seen.every((t) => t.status !== "triage")).toBe(true);
  });

  test("closed work drops off it", async () => {
    const open = (await owner.get("/api/standards")).data.tracking.standard;
    await owner.post(`/api/tickets/${open[0].id}/close`, { resolution: "Done." });
    const after = (await owner.get("/api/standards")).data.tracking.standard;
    expect(after.some((t: any) => t.id === open[0].id)).toBe(false);
  });
});

describe("recurring upkeep", () => {
  const owner = new Session();
  const outsider = new Session();
  let scheduleId = 0;
  let propertyId = 0;

  test("a landlord is offered the usual upkeep as starting points", async () => {
    const { data: lord } = await owner.post("/api/signup", {
      role: "landlord", username: uniq("rec"), password: "password123",
      displayName: "Rec R", propertyName: "Repeat House",
    });
    propertyId = lord.user.property.id;

    const { status, data } = await owner.get("/api/schedules");
    expect(status).toBe(200);
    expect(data.schedules).toEqual([]);
    const titles = data.suggestions.map((s: any) => s.title);
    expect(titles).toEqual([
      "Landscaping", "General cleaning", "Roof inspection", "Sewer health check",
    ]);
    // Cadences are offered rather than typed as raw day counts.
    expect(data.cadences.map((c: any) => c.days)).toContain(30);
  });

  test("creating one raises its first to-do straight away", async () => {
    const { status, data } = await owner.post("/api/schedules", {
      title: "Landscaping", category: "landscaping", intervalDays: 30,
      details: "Mow, edge and clear the grounds.",
    });
    expect(status).toBe(200);
    expect(data.schedules).toHaveLength(1);
    scheduleId = data.schedules[0].id;
    expect(data.schedules[0].open_now).toBe(1);

    const todo = (await owner.get("/api/tickets?status=open")).data.tickets
      .find((t: any) => t.title === "Landscaping");
    expect(todo).toBeTruthy();
    // It is an ordinary ticket: same list, same targets, and it says where it
    // came from.
    expect(todo.recurring_id).toBe(scheduleId);
    expect(todo.recurring_days).toBe(30);
    expect(todo.sla_tier).toBeTruthy();
    expect(todo.due_at).toBeTruthy();
  });

  test("the next one is scheduled a full cycle out", async () => {
    const { data } = await owner.get("/api/schedules");
    const next = new Date(data.schedules[0].next_due.replace(" ", "T") + "Z").getTime();
    const days = Math.round((next - Date.now()) / 86400_000);
    expect(days).toBeGreaterThanOrEqual(29);
    expect(days).toBeLessThanOrEqual(30);
  });

  // Time cannot be advanced over HTTP, so these reach into the test database to
  // age a schedule. Skipped when the suite is pointed at a deployment, where
  // there is no local file to reach into.
  test.skipIf(Boolean(EXTERNAL))("a cycle coming round raises the next one", async () => {
    const { Database } = await import("bun:sqlite");
    const raw = new Database(DB);
    raw.run("UPDATE recurring_tasks SET next_due = datetime('now','-1 day') WHERE id = ?",
      [scheduleId]);
    raw.close();

    await owner.get("/api/tickets?status=open"); // due schedules fire on the way in
    const { data } = await owner.get("/api/tickets?status=all");
    const raised = data.tickets.filter((t: any) => t.recurring_id === scheduleId);
    expect(raised.length).toBe(2);
  });

  test.skipIf(Boolean(EXTERNAL))("a year of missed cycles is one to-do, not twelve", async () => {
    const { Database } = await import("bun:sqlite");
    const raw = new Database(DB);
    raw.run("UPDATE recurring_tasks SET next_due = datetime('now','-365 day') WHERE id = ?",
      [scheduleId]);
    raw.close();

    await owner.get("/api/tickets?status=open");
    const { data } = await owner.get("/api/tickets?status=all");
    expect(data.tickets.filter((t: any) => t.recurring_id === scheduleId)).toHaveLength(3);

    // And the cadence lands back in the future rather than staying behind.
    const { data: after } = await owner.get("/api/schedules");
    const sched = after.schedules.find((s: any) => s.id === scheduleId);
    expect(new Date(sched.next_due.replace(" ", "T") + "Z").getTime())
      .toBeGreaterThan(Date.now());
  });

  test("a paused schedule stops raising anything", async () => {
    const paused = await owner.post(`/api/schedules/${scheduleId}`, { paused: true });
    expect(paused.data.schedules.find((s: any) => s.id === scheduleId).paused).toBe(1);
    if (!EXTERNAL) {
      const { Database } = await import("bun:sqlite");
      const raw = new Database(DB);
      raw.run("UPDATE recurring_tasks SET next_due = datetime('now','-1 day') WHERE id = ?",
        [scheduleId]);
      raw.close();
    }
    const before = (await owner.get("/api/tickets?status=all")).data.tickets
      .filter((t: any) => t.recurring_id === scheduleId).length;
    await owner.get("/api/tickets?status=open");
    const after = (await owner.get("/api/tickets?status=all")).data.tickets
      .filter((t: any) => t.recurring_id === scheduleId).length;
    expect(after).toBe(before);

    await owner.post(`/api/schedules/${scheduleId}`, { paused: false, intervalDays: 365 });
  });

  test("a schedule can be handed to a vendor, and the to-do arrives assigned", async () => {
    const portfolioCode = (await owner.get("/api/me")).data.user.portfolioCode;
    const vendor = new Session();
    const { data: v } = await vendor.post("/api/signup", {
      role: "vendor", username: uniq("mow"), password: "password123",
      displayName: "Mow Co", vendorCode: portfolioCode,
    });

    const { data } = await owner.post("/api/schedules", {
      title: "Sewer health check", category: "sewer", intervalDays: 365,
      vendorId: v.user.id,
    });
    const sewer = data.schedules.find((s: any) => s.title === "Sewer health check");
    expect(sewer.vendor_name).toBe("Mow Co");

    const job = (await vendor.get("/api/tickets?status=all&assigned=me")).data.tickets
      .find((t: any) => t.title === "Sewer health check");
    expect(job).toBeTruthy();
  });

  test("a long-neglected schedule raises one to-do, not a year of them", async () => {
    const { data } = await owner.post("/api/schedules", {
      title: "General cleaning", category: "cleaning", intervalDays: 30, startNow: false,
    });
    const cleaning = data.schedules.find((s: any) => s.title === "General cleaning");
    // Nothing yet — it was told to wait a cycle.
    expect(cleaning.open_now).toBe(0);
  });

  test("deleting keeps the work it already raised", async () => {
    const before = (await owner.get("/api/tickets?status=all")).data.tickets
      .filter((t: any) => t.recurring_id === scheduleId).length;
    expect(before).toBeGreaterThan(0);
    // The tickets stay; only the schedule behind them goes.

    const { status } = await owner.req(`/api/schedules/${scheduleId}`, { method: "DELETE" });
    expect(status).toBe(200);

    const kept = (await owner.get("/api/tickets?status=all")).data.tickets
      .filter((t: any) => t.title === "Landscaping").length;
    expect(kept).toBe(before);
  });

  test.each([
    ["no name", { intervalDays: 30 }],
    ["no cadence", { title: "Thing" }],
    ["a nonsense cadence", { title: "Thing", intervalDays: 0 }],
    ["an absurd cadence", { title: "Thing", intervalDays: 99999 }],
  ])("creating with %s is refused", async (_label, body) => {
    expect((await owner.post("/api/schedules", body)).status).toBe(400);
  });

  test("schedules belong to the landlord who made them", async () => {
    const { data } = await owner.get("/api/schedules");
    const mine = data.schedules[0].id;

    await outsider.post("/api/signup", {
      role: "landlord", username: uniq("nosy"), password: "password123", displayName: "Nosy N",
    });
    expect((await outsider.post(`/api/schedules/${mine}`, { paused: true })).status).toBe(404);
    expect((await outsider.req(`/api/schedules/${mine}`, { method: "DELETE" })).status).toBe(404);
    expect((await outsider.get("/api/schedules")).data.schedules).toEqual([]);

    // And cannot be aimed at a property they do not own.
    expect((await outsider.post("/api/schedules", {
      title: "Not mine", intervalDays: 30, propertyId,
    })).status).toBe(403);
  });

  test("tenants and vendors do not set up upkeep", async () => {
    const vendor = new Session();
    await vendor.post("/api/signup", {
      role: "vendor", username: uniq("nv"), password: "password123", displayName: "NV",
    });
    expect((await vendor.get("/api/schedules")).status).toBe(403);
    expect((await vendor.post("/api/schedules", { title: "x", intervalDays: 7 })).status).toBe(403);
  });
});

describe("triage quality", () => {
  const landlord = new Session();
  const tenant = new Session();
  let joinCode = "";

  const report = async (title: string, description: string) => {
    const { data } = await tenant.post("/api/tickets", { title, description });
    const reply = data.messages.find((m: any) => m.author === "bot")?.body ?? "";
    return { ticket: data.ticket, reply, id: data.ticket.id };
  };

  test("setup", async () => {
    const { data } = await landlord.post("/api/signup", {
      role: "landlord", username: uniq("diag"), password: "password123",
      displayName: "Diag D", propertyName: "Diagnostic House",
    });
    joinCode = data.user.property.joinCode;
    await tenant.post("/api/signup", {
      role: "tenant", username: uniq("dt"), password: "password123",
      displayName: "Dee T", joinCode, unit: "1A",
    });
  });

  // The word "attached" contains "ac", which used to match the air-conditioning
  // playbook and answer a ceiling leak with instructions about the thermostat.
  test("a keyword buried inside another word does not match", async () => {
    const { ticket, reply } = await report(
      "Ceiling stain above the shower",
      "A brown ring has appeared on the bathroom ceiling and it is spreading. Photos attached.",
    );
    expect(ticket.category).toBe("structural");
    expect(reply.toLowerCase()).not.toContain("thermostat");
    expect(reply.toLowerCase()).not.toContain("air filter");
  });

  test.each([
    ["Kitchen sink drains slowly", "Water pools in the basin and takes minutes to go down.", "plumbing"],
    ["No power in the bathroom", "The outlets are dead but the lights work.", "electrical"],
    ["Radiators are cold", "The heating came on and now nothing is warm.", "hvac"],
    ["Fridge is not cold", "Everything in it has gone warm since yesterday.", "appliance"],
    ["Front door will not lock", "The deadbolt does not engage any more.", "locks_security"],
  ])("%s is filed as the right kind of problem", async (title, description, category) => {
    const { ticket } = await report(title, description);
    expect(ticket.category).toBe(category);
  });

  test("the first reply explains what is likely, what to check, and why", async () => {
    const { reply } = await report(
      "Kitchen sink drains slowly",
      "Water pools in the basin and takes several minutes to go down.",
    );
    // A diagnosis, not just a question: it should say what is usually wrong...
    expect(reply.toLowerCase()).toContain("trap");
    // ...lay out what to check...
    expect(reply).toContain("Worth checking:");
    expect(reply).toMatch(/1\..+\n.+\n2\./s);
    // ...and end on exactly one question.
    expect(reply.trimEnd().endsWith("?")).toBe(true);
    expect(reply.split("?").length - 1).toBe(1);
    // Long enough to be useful, short enough to read on a phone.
    expect(reply.length).toBeGreaterThan(400);
    expect(reply.length).toBeLessThan(1600);
  });

  test("it says where the line is rather than just refusing", async () => {
    const { reply } = await report(
      "No power in the bathroom",
      "The outlets in the bathroom are all dead but the lights still work.",
    );
    expect(reply.toLowerCase()).toContain("gfci");
    // The panel is the boundary, and it should be named as one.
    expect(reply.toLowerCase()).toContain("electrician");
  });

  test("an emergency is never given troubleshooting steps", async () => {
    const { ticket, reply } = await report(
      "Smell of gas in the kitchen",
      "There is a strong smell of gas near the cooker.",
    );
    expect(ticket.priority).toBe("urgent");
    expect(ticket.status).toBe("open"); // straight past triage
    expect(reply.toLowerCase()).toContain("emergency services");
    expect(reply).not.toContain("Worth checking:");
  });

  test("what was ruled out reaches the landlord's summary", async () => {
    const { id } = await report(
      "Bathroom sink drains slowly",
      "It pools and drains very slowly, other taps are fine.",
    );
    await tenant.post(`/api/tickets/${id}/messages`, { body: "Only this one is slow." });
    await tenant.post(`/api/tickets/${id}/messages`, { body: "Plunged it hard, no change." });
    const { data } = await tenant.post(`/api/tickets/${id}/messages`, {
      body: "Still nothing, can someone come out?",
    });
    expect(data.ticket.status).toBe("open");
    // The landlord should see what has already been eliminated, not just a title.
    expect(data.ticket.summary).toMatch(/ruled out/);
  });

  test("a tenant asking for a person is not argued with", async () => {
    const { id } = await report("Oven door hinge", "The door drops open on its own.");
    const { data } = await tenant.post(`/api/tickets/${id}/messages`, {
      body: "I would rather someone just came out to look at it.",
    });
    expect(data.ticket.status).toBe("open");
  });
});
