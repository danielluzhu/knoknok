/* knoknok — front end. No framework, no build step. */

const $ = (sel) => document.querySelector(sel);
const state = {
  me: null, tickets: [], filter: null, selected: null,
  messages: [], busy: false, tenants: [], lastReadId: 0,
  // Messaging: a standing conversation with the other party, separate from the
  // per-request ticket threads. Keyed by tenant id on both sides.
  view: "requests", chats: [], chatWith: null, chat: null,
  chatMessages: [], chatLastReadId: 0,
};

/**
 * Where the API lives. Empty means same origin — the case when the server also
 * serves this page, locally or on Vercel. A static host such as GitHub Pages
 * cannot serve the API, so it sets window.KNOKNOK_API_BASE (see config.js) to
 * the API's origin and every request goes there instead.
 */
const API_BASE = (window.KNOKNOK_API_BASE || "").replace(/\/$/, "");
const CROSS_ORIGIN = API_BASE !== "";
const TOKEN_KEY = "knoknok_token";

/**
 * Same-origin auth rides on an httpOnly cookie, which this script cannot read
 * and therefore cannot leak. That cookie is third-party once the front end is
 * on another origin — Safari drops it, Chrome is heading the same way — so the
 * cross-origin build keeps the session token here and sends it as a bearer
 * header. Only that build touches localStorage.
 */
let authToken = CROSS_ORIGIN ? localStorage.getItem(TOKEN_KEY) : null;

function setToken(token) {
  if (!CROSS_ORIGIN) return;
  authToken = token ?? null;
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

async function api(path, options = {}) {
  const headers = { "content-type": "application/json" };
  if (authToken) headers.authorization = `Bearer ${authToken}`;
  const res = await fetch(API_BASE + path, {
    method: options.method ?? "GET",
    credentials: CROSS_ORIGIN ? "omit" : "same-origin",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed.");
  return data;
}

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const CATEGORY_LABEL = {
  plumbing: "Plumbing", electrical: "Electrical", hvac: "Heating & cooling",
  appliance: "Appliance", pest: "Pest", structural: "Building", 
  locks_security: "Locks & security", common_area: "Common area", other: "Other",
};

const PRIORITY_LABEL = { low: "Low", normal: "Normal", high: "High", urgent: "Urgent" };

const options = (labels, selected) =>
  Object.entries(labels)
    .map(([v, l]) => `<option value="${v}"${v === selected ? " selected" : ""}>${l}</option>`)
    .join("");

function when(iso) {
  if (!iso) return "";
  const d = new Date(iso.replace(" ", "T") + "Z");
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  if (mins < 60 * 24 * 7) return `${Math.round(mins / 1440)}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/* -------------------------------------------------------------- auth view */

let authMode = "login";

function setAuthMode(mode) {
  authMode = mode;
  document.querySelectorAll("#authTabs .tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.mode === mode));
  $("#signupOnly").classList.toggle("hidden", mode === "login");
  $("#authSubmit").textContent = mode === "login" ? "Sign in" : "Create account";
  $("#authError").classList.add("hidden");
  $("#authForm").password.autocomplete = mode === "login" ? "current-password" : "new-password";
}

function wireAuth() {
  document.querySelectorAll("#authTabs .tab").forEach((t) =>
    t.addEventListener("click", () => setAuthMode(t.dataset.mode)));

  document.querySelectorAll('.role input').forEach((input) => {
    input.addEventListener("change", () => {
      document.querySelectorAll(".role").forEach((r) =>
        r.classList.toggle("selected", r.contains(document.querySelector(".role input:checked"))));
      const landlord = input.value === "landlord" && input.checked;
      $("#tenantFields").classList.toggle("hidden", landlord);
      $("#landlordFields").classList.toggle("hidden", !landlord);
    });
  });

  $("#authForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const err = $("#authError");
    err.classList.add("hidden");
    $("#authSubmit").disabled = true;
    try {
      const body = Object.fromEntries(f.entries());
      if (body.joinCode) body.joinCode = body.joinCode.toUpperCase();
      const { user, token } = await api(authMode === "login" ? "/api/login" : "/api/signup", {
        method: "POST", body,
      });
      setToken(token);
      state.me = user;
      e.target.reset();
      enterApp();
    } catch (ex) {
      err.textContent = ex.message;
      err.classList.remove("hidden");
    } finally {
      $("#authSubmit").disabled = false;
    }
  });
}

/* --------------------------------------------------------------- app view */

function enterApp() {
  const me = state.me;
  $("#auth").classList.add("hidden");
  $("#app").classList.remove("hidden");
  $("#propName").textContent = me.property.name;
  $("#whoami").textContent = me.role === "tenant"
    ? `${me.displayName} · Unit ${me.unit}`
    : `${me.displayName} · landlord`;
  const badge = $("#botBadge");
  badge.textContent = me.botEngine === "claude" ? "bot: claude" : "bot: built-in";
  badge.title = me.botEngine === "claude"
    ? "Triage answered by Claude Opus 5"
    : "Triage answered by the built-in diagnostic script (set ANTHROPIC_API_KEY for Claude)";

  $("#newBtn").textContent = me.role === "tenant" ? "+ New request" : "+ New to-do";
  state.filter = me.role === "tenant" ? "all" : "open";
  state.view = "requests";
  renderFilters();
  renderViews();

  const info = $("#landlordInfo");
  if (me.role === "landlord") {
    info.classList.remove("hidden");
    loadProperty();
  } else {
    info.classList.add("hidden");
  }

  refresh();
  // Fetched even on the requests view, so the Messages badge is right on arrival.
  refreshChats().catch(() => {});
}

/** Landlord-only sidebar footer: workload at a glance, the join code, who's here. */
async function loadProperty() {
  try {
    const { tenants, counts } = await api("/api/property");
    state.tenants = tenants;
    const open = counts.open ?? 0;
    const done = counts.closed ?? 0;
    $("#landlordInfo").innerHTML = `
      <div class="counts">
        <span><b>${open}</b> open</span>
        <span><b>${done}</b> done</span>
        <span><b>${tenants.length}</b> tenant${tenants.length === 1 ? "" : "s"}</span>
      </div>
      Tenants join this property with the code:<br>
      <span class="code">${esc(state.me.property.joinCode)}</span>
      <div style="margin-top:10px">${
        tenants.length
          ? tenants.map((t) => `${esc(t.display_name)} (${esc(t.unit || "—")})`).join(", ")
          : "No tenants have joined yet."
      }</div>`;
  } catch {
    /* sidebar extras are optional — never block the list on them */
  }
}

/* --------------------------------------------------------------- messaging */

function renderViews() {
  const unread = state.chats.reduce((n, c) => n + (c.unread || 0), 0);
  $("#views").innerHTML = [
    ["requests", state.me.role === "tenant" ? "Requests" : "To-dos", 0],
    ["messages", "Messages", unread],
  ]
    .map(([v, label, n]) =>
      `<button data-v="${v}" class="${state.view === v ? "active" : ""}">${label}${
        n ? `<span class="unread">${n}</span>` : ""
      }</button>`)
    .join("");
  $("#views").querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => setView(b.dataset.v)));
}

function setView(view) {
  if (state.view === view) return;
  state.view = view;
  const requests = view === "requests";
  $("#filters").classList.toggle("hidden", !requests);
  $("#newBtn").classList.toggle("hidden", !requests);
  renderViews();
  if (requests) {
    state.chatWith = null;
    refresh(false);
    renderDetail();
  } else {
    state.selected = null;
    state.ticket = null;
    refreshChats();
  }
}

async function refreshChats() {
  const { chats } = await api("/api/chats");
  state.chats = chats;
  renderViews();
  if (state.view !== "messages") return;
  renderChatList();
  // A tenant has exactly one conversation, so open it rather than making them click.
  if (!state.chatWith && state.me.role === "tenant" && chats.length === 1) {
    await openChat(chats[0].id);
  } else if (!state.chatWith) {
    renderChatDetail();
  }
}

function renderChatList() {
  const list = $("#list");
  if (!state.chats.length) {
    list.innerHTML = `<div class="empty">${
      state.me.role === "landlord"
        ? "No tenants have joined yet.<br>Share your property code and they'll appear here."
        : "Your landlord's account is not set up yet."
    }</div>`;
    return;
  }
  list.innerHTML = state.chats.map((c) => `
    <div class="row ${state.chatWith === c.id ? "active" : ""} ${c.unread ? "has-unread" : ""}" data-id="${c.id}">
      <div class="chat-row-top">
        <span class="chat-name">${esc(c.name)}</span>
        <span class="row-marks">${
          c.unread ? `<span class="unread">${c.unread}</span>` : ""
        }<span class="row-meta">${c.last_at ? when(c.last_at) : ""}</span></span>
      </div>
      <div class="chat-sub">${esc(c.subtitle || "")}</div>
      <div class="row-snippet ${c.last_message ? "" : "chat-empty"}">${
        c.last_message ? esc(c.last_message) : "No messages yet"
      }</div>
    </div>`).join("");
  list.querySelectorAll(".row").forEach((r) =>
    r.addEventListener("click", () => openChat(Number(r.dataset.id))));
}

async function openChat(id, scroll = true) {
  const { conversation, messages, lastReadId } = await api(`/api/chats/${id}`);
  const switching = state.chatWith !== id;
  state.chatWith = id;
  state.chat = conversation;
  state.chatMessages = messages;
  if (switching) state.chatLastReadId = lastReadId ?? 0;
  // The server just marked this read; clear the cached count so the badge and
  // the row update now rather than at the next poll.
  const cached = state.chats.find((c) => c.id === id);
  if (cached) cached.unread = 0;
  renderChatList();
  renderViews();
  renderChatDetail(scroll);
}

function renderChatDetail(scroll = true) {
  const el = $("#detail");
  const draft = $("#composerInput")?.value ?? "";
  const prev = $("#thread");
  const prevScroll = prev?.scrollTop ?? 0;
  const wasAtBottom = !prev || prev.scrollHeight - prev.scrollTop - prev.clientHeight < 80;

  if (!state.chatWith || !state.chat) {
    el.innerHTML = `<div class="placeholder"><div>
      <p style="font-size:34px;margin:0">💬</p>
      <p>Pick someone to message.<br>Tenants can only message you, so nothing here is a group thread.</p>
    </div></div>`;
    return;
  }

  const firstNew = state.chatMessages.find(
    (m) => m.id > (state.chatLastReadId ?? 0) && m.sender_id !== state.me.id,
  );

  el.innerHTML = `
    <div class="detail-head">
      <h2>${esc(state.chat.name)}</h2>
      <div class="detail-meta"><span>${esc(state.chat.subtitle || "")}</span></div>
    </div>
    <div class="thread" id="thread">${
      state.chatMessages.map((m) => {
        const mine = m.sender_id === state.me.id;
        const cls = mine ? state.me.role : `${m.sender_role} mine-left`;
        const divider = firstNew && m.id === firstNew.id
          ? '<div class="new-line"><span>new</span></div>' : "";
        return `${divider}<div class="msg ${cls}">
          <div class="who-line">${esc(m.sender_name || "")}</div>
          <div class="bubble">${esc(m.body)}</div>
        </div>`;
      }).join("") ||
      '<div class="placeholder"><div><p>No messages yet — say hello.</p></div></div>'
    }</div>
    <div class="composer">
      <textarea id="composerInput" rows="1" placeholder="Message ${esc(state.chat.name)}…"></textarea>
      <button class="primary" id="sendBtn">Send</button>
    </div>`;

  const input = $("#composerInput");
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 160) + "px";
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
  $("#sendBtn").addEventListener("click", sendChat);
  if (draft) {
    input.value = draft;
    input.style.height = Math.min(input.scrollHeight, 160) + "px";
  }
  if (scroll) input.focus();
  const thread = $("#thread");
  if (thread) thread.scrollTop = wasAtBottom ? thread.scrollHeight : prevScroll;
}

async function sendChat() {
  const input = $("#composerInput");
  const body = input.value.trim();
  if (!body || state.busy) return;
  input.value = "";
  input.style.height = "auto";

  // Optimistic echo, so the thread feels immediate over a slow link.
  state.chatMessages.push({
    id: Number.MAX_SAFE_INTEGER, sender_id: state.me.id,
    sender_name: state.me.displayName, sender_role: state.me.role, body,
  });
  renderChatDetail(false);

  try {
    const { messages } = await api(`/api/chats/${state.chatWith}/messages`, {
      method: "POST", body: { body },
    });
    state.chatMessages = messages;
  } catch (ex) {
    alert(ex.message);
    input.value = body; // hand the text back rather than losing it
  } finally {
    renderChatDetail(false);
    refreshChats();
  }
}

/* ---------------------------------------------------------------- requests */

function renderFilters() {
  const opts = state.me.role === "tenant"
    ? [["all", "All"], ["triage", "With bot"], ["open", "With landlord"], ["closed", "Closed"]]
    : [["open", "To-do"], ["closed", "Done"], ["all", "All"]];
  $("#filters").innerHTML = opts
    .map(([v, l]) => `<button data-f="${v}" class="${state.filter === v ? "active" : ""}">${l}</button>`)
    .join("");
  $("#filters").querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => { state.filter = b.dataset.f; renderFilters(); refresh(); }));
}

async function refresh(keepSelection = true) {
  const { tickets } = await api(`/api/tickets?status=${state.filter}`);
  state.tickets = tickets;
  renderList();
  if (keepSelection && state.selected && !tickets.some((t) => t.id === state.selected)) {
    // still show the open thread even when the filter excludes it
    await openTicket(state.selected, false);
  } else if (!state.selected) {
    renderDetail();
  }
}

function renderList() {
  const list = $("#list");
  if (!state.tickets.length) {
    list.innerHTML = `<div class="empty">${
      state.me.role === "tenant"
        ? "Nothing here yet.<br>Tap <b>+ New request</b> when something needs fixing."
        : "Nothing on the list.<br>Tenant requests land here once the assistant escalates them."
    }</div>`;
    return;
  }
  list.innerHTML = state.tickets.map((t) => {
    const statusPill = t.status === "open"
      ? `<span class="pill open">to-do</span>`
      : t.status === "triage" ? `<span class="pill triage">with bot</span>`
      : `<span class="pill closed">closed</span>`;
    const who = state.me.role === "landlord" && t.tenant_name
      ? `${esc(t.tenant_name)}${t.tenant_unit ? " · " + esc(t.tenant_unit) : ""}`
      : CATEGORY_LABEL[t.category] || "Other";
    // A tenant's own request vs one their landlord raised with them.
    const fromLandlord = state.me.role === "tenant" && t.creator_role === "landlord";
    const unread = t.unread > 0
      ? `<span class="unread" title="${t.unread} new message${t.unread === 1 ? "" : "s"}">${t.unread}</span>`
      : "";
    return `<div class="row ${state.selected === t.id ? "active" : ""} ${t.unread > 0 ? "has-unread" : ""}" data-id="${t.id}">
      <div class="row-top"><span class="row-title">${esc(t.title)}</span>
        <span class="row-marks">${unread}<span class="dot p-${t.priority}" title="priority: ${t.priority}"></span></span></div>
      <div class="row-meta">${statusPill}${
        fromLandlord ? '<span class="pill from">from landlord</span>' : ""
      }<span>${who}</span><span>${when(t.updated_at)}</span></div>
      <div class="row-snippet">${esc(t.last_message || t.summary)}</div>
    </div>`;
  }).join("");
  list.querySelectorAll(".row").forEach((r) =>
    r.addEventListener("click", () => openTicket(Number(r.dataset.id))));
}

async function openTicket(id, scroll = true) {
  const { ticket, messages, lastReadId } = await api(`/api/tickets/${id}`);
  const switching = state.selected !== id;
  state.selected = id;
  state.ticket = ticket;
  state.messages = messages;
  // Only move the "new messages" line when opening a different thread — polling
  // the thread you are already reading should not shuffle it under you.
  if (switching) state.lastReadId = lastReadId ?? 0;
  // Same as chats: opening it marked it read server-side, so drop the cached
  // count instead of waiting for the next poll to catch up.
  const cached = state.tickets.find((t) => t.id === id);
  if (cached) cached.unread = 0;
  renderList();
  renderDetail(scroll);
}

function renderDetail(scroll = true) {
  const el = $("#detail");
  // Background polling re-renders this pane, so hold on to anything the user is
  // part-way through typing, and do not yank them away from where they scrolled.
  const draft = $("#composerInput")?.value ?? "";
  const prev = $("#thread");
  const prevScroll = prev?.scrollTop ?? 0;
  const wasAtBottom = !prev || prev.scrollHeight - prev.scrollTop - prev.clientHeight < 80;
  if (!state.selected || !state.ticket) {
    el.innerHTML = `<div class="placeholder"><div>
      <p style="font-size:34px;margin:0">🔧</p>
      <p>${state.me.role === "tenant"
        ? "Pick a request, or start a new one.<br>The assistant will try to sort it out before it ever reaches your landlord."
        : "Pick an item to see the full history — including the tenant's conversation with the assistant."}</p>
    </div></div>`;
    return;
  }
  const t = state.ticket;
  const isTenant = state.me.role === "tenant";
  const closed = t.status === "closed";

  const actions = [];
  if (t.status === "triage" && isTenant) {
    actions.push(`<button class="ghost" id="escalateBtn">Send to landlord now</button>`);
  }
  if (!closed) actions.push(`<button class="primary small" id="closeBtn">${
    isTenant ? "Mark as resolved" : "Mark complete"}</button>`);
  if (closed) actions.push(`<button class="ghost" id="reopenBtn">Reopen</button>`);

  // The landlord owns the list, so they can re-file a task inline. The bot's
  // guess at priority and category is a starting point, not the final word.
  const canEdit = !isTenant && !closed;
  const meta = canEdit
    ? `<label class="inline-edit">priority
         <select id="prioritySelect">${options(PRIORITY_LABEL, t.priority)}</select></label>
       <label class="inline-edit">category
         <select id="categorySelect">${options(CATEGORY_LABEL, t.category)}</select></label>`
    : `${t.priority === "urgent" ? '<span class="pill urgent">urgent</span>'
        : `<span>priority: ${esc(t.priority)}</span>`}
       <span>${esc(CATEGORY_LABEL[t.category] || "Other")}</span>`;

  const party = !isTenant && t.tenant_name
    ? `<span>${esc(t.tenant_name)}${t.tenant_unit ? " · " + esc(t.tenant_unit) : ""}</span>`
    : isTenant && t.creator_role === "landlord"
      ? `<span class="pill from">raised by ${esc(t.creator_name || "your landlord")}</span>`
      : !isTenant && !t.tenant_id
        ? '<span>internal to-do</span>'
        : "";

  // The one-liner the bot wrote for the landlord. Worth showing to both sides —
  // the tenant gets to see exactly what was passed on about their request. Skip
  // it when it just repeats the title or the opening message, which is the case
  // for a to-do the landlord typed out themselves.
  const firstBody = state.messages.find((m) => m.author !== "system")?.body?.trim();
  const briefWorthShowing =
    t.summary && t.summary !== t.title && t.summary !== firstBody;
  const brief = briefWorthShowing
    ? `<div class="brief"><b>Passed to the landlord as:</b> ${esc(t.summary)}</div>`
    : "";

  el.innerHTML = `
    <div class="detail-head">
      <h2>${esc(t.title)}</h2>
      <div class="detail-meta">
        ${t.status === "open" ? '<span class="pill open">to-do</span>'
          : t.status === "triage" ? '<span class="pill triage">with the assistant</span>'
          : '<span class="pill closed">closed</span>'}
        ${meta}
        ${party}
        <span>opened ${when(t.created_at)}</span>
      </div>
      ${brief}
      <div class="detail-actions">${actions.join("")}</div>
    </div>
    ${closed && t.resolution ? `<div class="resolution" style="margin-top:14px"><b>Resolved:</b> ${esc(t.resolution)}</div>` : ""}
    <div class="thread" id="thread">${renderThread()}
      ${state.busy ? '<div class="msg bot"><div class="bubble thinking">The assistant is thinking…</div></div>' : ""}
    </div>
    ${closed ? "" : `<div class="composer">
      <textarea id="composerInput" rows="1" placeholder="${
        t.status === "triage" && isTenant ? "Answer the assistant…" : "Write a message…"}"></textarea>
      <button class="primary" id="sendBtn">Send</button>
    </div>`}`;

  $("#closeBtn")?.addEventListener("click", onClose);
  $("#reopenBtn")?.addEventListener("click", () => act(`/api/tickets/${t.id}/reopen`));
  $("#escalateBtn")?.addEventListener("click", () => act(`/api/tickets/${t.id}/escalate`));
  $("#prioritySelect")?.addEventListener("change", (e) =>
    act(`/api/tickets/${t.id}/update`, { priority: e.target.value }));
  $("#categorySelect")?.addEventListener("change", (e) =>
    act(`/api/tickets/${t.id}/update`, { category: e.target.value }));

  const input = $("#composerInput");
  if (input) {
    input.addEventListener("input", () => {
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, 160) + "px";
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
    });
    $("#sendBtn").addEventListener("click", send);
    if (draft) {
      input.value = draft;
      input.style.height = Math.min(input.scrollHeight, 160) + "px";
    }
    if (scroll) input.focus();
  }
  const thread = $("#thread");
  if (thread) thread.scrollTop = wasAtBottom ? thread.scrollHeight : prevScroll;
}

/** The thread, with a divider at the point this user last left off. */
function renderThread() {
  const firstNew = state.messages.find(
    (m) => m.id > (state.lastReadId ?? 0) && m.author !== "system" && m.user_id !== state.me.id,
  );
  return state.messages
    .map((m) => {
      const divider = firstNew && m.id === firstNew.id
        ? '<div class="new-line"><span>new</span></div>'
        : "";
      return divider + renderMessage(m);
    })
    .join("");
}

function renderMessage(m) {
  const label = m.author === "bot" ? "Maintenance assistant"
    : m.author === "system" ? ""
    : m.author_name || (m.author === "tenant" ? "Tenant" : "Landlord");
  // My own messages sit on the right; the other party's on the left.
  const mine = m.author === state.me.role;
  const cls = m.author === "system" ? "system"
    : m.author === "bot" ? "bot"
    : mine ? m.author : `${m.author} mine-left`;
  return `<div class="msg ${cls}">
    ${label ? `<div class="who-line">${esc(label)}</div>` : ""}
    <div class="bubble">${esc(m.body)}</div>
  </div>`;
}

async function act(path, body) {
  try {
    const { ticket, messages } = await api(path, { method: "POST", body: body || {} });
    state.ticket = ticket;
    state.messages = messages;
    renderDetail();
    refresh();
    if (state.me.role === "landlord") loadProperty();
  } catch (ex) {
    alert(ex.message);
    // Re-sync from the server so a rejected edit doesn't leave a stale dropdown.
    if (state.selected) openTicket(state.selected, false);
  }
}

function onClose() {
  const note = prompt(
    state.me.role === "tenant"
      ? "Anything to note before closing? (optional)"
      : "What was done? (optional — shows in the history)",
    "",
  );
  if (note === null) return; // cancelled
  act(`/api/tickets/${state.ticket.id}/close`, { resolution: note });
}

async function send() {
  const input = $("#composerInput");
  const body = input.value.trim();
  if (!body || state.busy) return;
  input.value = "";
  input.style.height = "auto";

  // Optimistic echo so the thread feels immediate while the bot thinks.
  state.messages.push({ author: state.me.role, author_name: state.me.displayName, body });
  const waitingOnBot = state.ticket.status === "triage" && state.me.role === "tenant";
  state.busy = waitingOnBot;
  renderDetail(false);

  try {
    const res = await api(`/api/tickets/${state.ticket.id}/messages`, { method: "POST", body: { body } });
    state.ticket = res.ticket;
    state.messages = res.messages;
  } catch (ex) {
    alert(ex.message);
  } finally {
    state.busy = false;
    renderDetail(false);
    refresh();
  }
}

/* --------------------------------------------------------------- new item */

function wireModal() {
  const modal = $("#modal");
  const open = () => {
    const tenant = state.me.role === "tenant";
    $("#modalTitle").textContent = tenant ? "New maintenance request" : "New to-do";
    $("#modalSubmit").textContent = tenant ? "Start with the assistant" : "Add to list";
    $("#descLabel").textContent = tenant ? "What's happening?" : "Details (optional)";
    $("#modalHint").textContent = tenant
      ? "The assistant will ask a couple of questions first — plenty of things turn out to have a two-minute fix. If not, it goes straight to your landlord."
      : "This goes on your to-do list. Tenant requests arrive here automatically once triaged.";
    document.querySelectorAll(".landlord-field").forEach((f) => f.classList.toggle("hidden", tenant));
    if (!tenant) {
      $("#newCategory").innerHTML = options(CATEGORY_LABEL, "other");
      $("#newTenant").innerHTML =
        '<option value="">Just me — internal to-do</option>' +
        state.tenants.map((t) =>
          `<option value="${t.id}">${esc(t.display_name)}${t.unit ? " · " + esc(t.unit) : ""}</option>`
        ).join("");
    }
    $("#newDesc").required = tenant;
    $("#modalError").classList.add("hidden");
    modal.classList.remove("hidden");
    $("#newTitle").focus();
  };
  $("#newBtn").addEventListener("click", open);
  $("#modalCancel").addEventListener("click", () => modal.classList.add("hidden"));
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.add("hidden"); });

  $("#newForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("#modalSubmit");
    const err = $("#modalError");
    btn.disabled = true;
    if (state.me.role === "tenant") btn.textContent = "Asking the assistant…";
    try {
      const body = Object.fromEntries(new FormData(e.target).entries());
      const { ticket } = await api("/api/tickets", { method: "POST", body });
      e.target.reset();
      modal.classList.add("hidden");
      await refresh(false);
      await openTicket(ticket.id);
    } catch (ex) {
      err.textContent = ex.message;
      err.classList.remove("hidden");
    } finally {
      btn.disabled = false;
      btn.textContent = state.me.role === "tenant" ? "Start with the assistant" : "Add to list";
    }
  });
}

/* ------------------------------------------------------------------ boot */

$("#logout").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" }).catch(() => {});
  setToken(null);
  location.reload();
});

function wireAccount() {
  const modal = $("#accountModal");
  const close = () => modal.classList.add("hidden");
  $("#accountBtn").addEventListener("click", () => {
    $("#accountWho").textContent =
      `Signed in as ${state.me.displayName} (${state.me.username}).`;
    $("#passwordForm").reset();
    $("#accountError").classList.add("hidden");
    $("#accountOk").classList.add("hidden");
    modal.classList.remove("hidden");
  });
  $("#accountCancel").addEventListener("click", close);
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });

  $("#passwordForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("#accountError");
    const ok = $("#accountOk");
    err.classList.add("hidden");
    ok.classList.add("hidden");
    $("#accountSubmit").disabled = true;
    try {
      await api("/api/password", {
        method: "POST",
        body: Object.fromEntries(new FormData(e.target).entries()),
      });
      e.target.reset();
      ok.classList.remove("hidden");
    } catch (ex) {
      err.textContent = ex.message;
      err.classList.remove("hidden");
    } finally {
      $("#accountSubmit").disabled = false;
    }
  });
}

wireAuth();
wireModal();
wireAccount();
setAuthMode("login");

// A static host cannot serve the API, so if this page is on one and nobody told
// it where the API lives, say so plainly instead of failing request by request.
if (!CROSS_ORIGIN && /\.github\.io$/.test(location.hostname)) {
  document.body.innerHTML =
    '<div class="auth"><div class="auth-card">' +
    '<h1 class="logo">knoknok</h1>' +
    "<p class=\"tagline\">This page is hosted on GitHub Pages, which serves files but " +
    "cannot run the API. Set the repository variable <b>API_BASE_URL</b> to the deployed " +
    "API's origin and re-run the Pages workflow.</p></div></div>";
} else {
  api("/api/me")
    .then(({ user }) => {
      if (user) { state.me = user; enterApp(); }
      else $("#auth").classList.remove("hidden");
    })
    .catch(() => {
      // A stale token, or the API being unreachable, both land here.
      setToken(null);
      $("#auth").classList.remove("hidden");
    });
}

// Keep things fresh so each side sees the other's replies without a refresh.
setInterval(() => {
  if (!state.me || state.busy || document.hidden) return;
  // Conversations are polled in either view, so the Messages badge stays live.
  refreshChats().catch(() => {});
  if (state.view === "requests") {
    refresh().catch(() => {});
    if (state.selected) openTicket(state.selected, false).catch(() => {});
  } else if (state.chatWith) {
    openChat(state.chatWith, false).catch(() => {});
  }
}, 15000);
