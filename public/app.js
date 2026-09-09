/* knoknok — front end. No framework, no build step. */

const $ = (sel) => document.querySelector(sel);
const state = {
  me: null, tickets: [], filter: null, selected: null,
  messages: [], busy: false, tenants: [], lastReadId: 0,
  // Messaging: a standing conversation with the other party, separate from the
  // per-request ticket threads. Keyed by tenant id on both sides.
  view: "requests", chats: [], chatWith: null, chat: null,
  chatMessages: [], chatLastReadId: 0,
  // Landlords and vendors both span several properties. `properties` is what the
  // header switcher offers; `scope` is what is being looked at — "all" (the
  // default) or one property id. `me.property` stays the cursor the server uses
  // when something has to land somewhere specific.
  properties: [], scope: "all",
  // The landlord's vendor network, for the assignment picker.
  vendors: [],
  // Recurring upkeep, and the options for setting it up.
  schedules: [], cadences: [], suggestions: [], scheduleOpen: null,
  // The decision tree behind a tenant's new request, from /api/intake.
  intakeTree: null,
};

/** The `?property=` every scoped request carries. */
const scopeQuery = () => `property=${state.scope}`;

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

/** A stable hue per person, so the same name always gets the same colour. */
const hueOf = (name) => {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
};

const initialsOf = (name) =>
  String(name).trim().split(/\s+/).slice(0, 2).map((w) => w[0] || "").join("").toUpperCase();

const avatar = (name, extra = "") =>
  `<span class="avatar ${extra}" style="--h:${hueOf(name)}" aria-hidden="true">${
    esc(initialsOf(name))
  }</span>`;

const CATEGORY_LABEL = {
  plumbing: "Plumbing", electrical: "Electrical", hvac: "Heating & cooling",
  appliance: "Appliance", pest: "Pest", structural: "Building",
  locks_security: "Locks & security", common_area: "Common area",
  landscaping: "Landscaping", roofing: "Roof", cleaning: "Cleaning", sewer: "Sewer",
  other: "Other",
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

/* ------------------------------------------------------------- schedules */

async function loadSchedules() {
  const { schedules, cadences, suggestions } = await api(`/api/schedules?${scopeQuery()}`);
  state.schedules = schedules;
  state.cadences = cadences;
  state.suggestions = suggestions;
  renderScheduleList();
  renderScheduleDetail();
  // A schedule firing creates a to-do, so the counts behind us have moved.
  loadProperty();
}

function renderScheduleList() {
  const list = $("#list");
  if (!state.schedules.length) {
    list.innerHTML = `<div class="empty">
      Nothing recurring yet.<br>Set up landscaping, cleaning, roof checks and the like
      so they raise themselves.
      <div style="margin-top:14px"><button class="primary small" id="firstSchedule">+ Add one</button></div>
    </div>`;
    $("#firstSchedule").addEventListener("click", openScheduleModal);
    return;
  }
  list.innerHTML = state.schedules.map((r) => {
    const next = new Date(r.next_due.replace(" ", "T") + "Z");
    const days = Math.ceil((next.getTime() - Date.now()) / 86400_000);
    const when = r.paused ? "paused"
      : days <= 0 ? "due now"
      : days === 1 ? "due tomorrow"
      : `due in ${days}d`;
    return `<div class="row ${r.paused ? "row-paused" : ""}" data-id="${r.id}">
      <div class="row-top"><span class="row-title">${esc(r.title)}</span>
        <span class="row-marks"><span class="row-meta">${when}</span></span></div>
      <div class="row-meta">
        <span class="pill ${r.paused ? "closed" : "open"}">${esc(CADENCE_LABEL(r.interval_days))}</span>
        ${state.scope === "all" ? `<span class="pill where">${esc(r.property_name)}</span>` : ""}
        ${r.vendor_name ? `<span class="pill taken">${esc(r.vendor_name)}</span>` : ""}
        <span>${esc(CATEGORY_LABEL[r.category] || "Other")}</span>
      </div>
      ${r.details ? `<div class="row-snippet">${esc(r.details)}</div>` : ""}
    </div>`;
  }).join("");
  list.querySelectorAll(".row").forEach((r) =>
    r.addEventListener("click", () => {
      state.scheduleOpen = Number(r.dataset.id);
      renderScheduleDetail();
    }));
}

function renderScheduleDetail() {
  const el = $("#detail");
  const r = state.schedules.find((x) => x.id === state.scheduleOpen);
  if (!r) {
    el.innerHTML = `<div class="placeholder"><div>
      <p style="font-size:34px;margin:0">🗓️</p>
      <p>Upkeep that comes round again — landscaping, cleaning, roof checks,
      a sewer survey.<br>Each one raises an ordinary to-do when it falls due.</p>
      <p style="margin-top:18px"><button class="primary" id="addSchedule">+ New recurring task</button></p>
    </div></div>`;
    $("#addSchedule").addEventListener("click", openScheduleModal);
    return;
  }
  const next = new Date(r.next_due.replace(" ", "T") + "Z");
  el.innerHTML = `
    <div class="detail-head">
      <h2>${esc(r.title)}</h2>
      <div class="detail-meta">
        <span class="pill ${r.paused ? "closed" : "open"}">${
          r.paused ? "paused" : esc(CADENCE_LABEL(r.interval_days))}</span>
        <span class="pill where">${esc(r.property_name)}</span>
        <span>${esc(CATEGORY_LABEL[r.category] || "Other")}</span>
        <span>next ${next.toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
        ${r.last_run ? `<span>last raised ${when(r.last_run)}</span>` : "<span>never raised yet</span>"}
        ${r.open_now ? `<span class="pill open">${r.open_now} open now</span>` : ""}
      </div>
      <div class="detail-actions">
        <label class="inline-edit">how often
          <select id="schedCadence">${
            state.cadences.map((c) =>
              `<option value="${c.days}"${c.days === r.interval_days ? " selected" : ""}>${
                esc(c.label)}</option>`).join("") +
            (state.cadences.some((c) => c.days === r.interval_days) ? "" :
              `<option value="${r.interval_days}" selected>${esc(CADENCE_LABEL(r.interval_days))}</option>`)
          }</select></label>
        <label class="inline-edit">vendor
          <select id="schedVendor">
            <option value="">Nobody yet</option>
            ${state.vendors.map((v) =>
              `<option value="${v.id}"${v.id === r.assigned_vendor_id ? " selected" : ""}>${
                esc(v.display_name)}</option>`).join("")}
          </select></label>
        <button class="ghost" id="schedPause">${r.paused ? "Resume" : "Pause"}</button>
        <button class="ghost" id="schedDelete">Delete</button>
      </div>
    </div>
    ${r.details ? `<div class="brief" style="margin:14px 26px">${esc(r.details)}</div>` : ""}
    <div class="placeholder"><div><p>
      Each time this falls due it raises a to-do on ${esc(r.property_name)}${
        r.vendor_name ? `, assigned to ${esc(r.vendor_name)}` : ""}.
    </p></div></div>`;

  const act = async (body, method = "POST") => {
    try {
      const res = await api(`/api/schedules/${r.id}`, { method, body });
      state.schedules = res.schedules;
      if (method === "DELETE") state.scheduleOpen = null;
      renderScheduleList();
      renderScheduleDetail();
    } catch (ex) { alert(ex.message); }
  };
  $("#schedPause").addEventListener("click", () => act({ paused: !r.paused }));
  $("#schedDelete").addEventListener("click", () => {
    if (confirm(`Delete "${r.title}"? To-dos it already raised are kept.`)) act(null, "DELETE");
  });
  $("#schedCadence").addEventListener("change", (e) =>
    act({ intervalDays: Number(e.target.value) }));
  $("#schedVendor").addEventListener("change", (e) =>
    act({ vendorId: e.target.value || null }));
}

function openScheduleModal() {
  const modal = $("#scheduleModal");
  $("#scheduleForm").reset();
  $("#scheduleError").classList.add("hidden");
  $("#scheduleCadence").innerHTML = state.cadences
    .map((c) => `<option value="${c.days}"${c.days === 30 ? " selected" : ""}>${esc(c.label)}</option>`)
    .join("");
  $("#scheduleCategory").innerHTML = options(CATEGORY_LABEL, "other");
  $("#scheduleProperty").innerHTML = state.properties
    .map((p) => `<option value="${p.id}"${
      p.id === state.me.property?.id ? " selected" : ""}>${esc(p.name)}</option>`).join("");
  $("#scheduleVendor").innerHTML = '<option value="">Nobody yet</option>' +
    state.vendors.map((v) => `<option value="${v.id}">${esc(v.display_name)}</option>`).join("");

  // The upkeep most buildings need, as one click rather than a blank form.
  $("#scheduleSuggestions").innerHTML = state.suggestions
    .map((s, i) => `<button type="button" class="suggestion" data-i="${i}">${esc(s.title)}
      <small>${esc(CADENCE_LABEL(s.interval_days))}</small></button>`).join("");
  $("#scheduleSuggestions").querySelectorAll(".suggestion").forEach((b) =>
    b.addEventListener("click", () => {
      const s = state.suggestions[Number(b.dataset.i)];
      $("#scheduleTitle").value = s.title;
      $("#scheduleDetails").value = s.details;
      $("#scheduleCategory").value = s.category;
      $("#scheduleCadence").value = String(s.interval_days);
      $("#scheduleSuggestions").querySelectorAll(".suggestion")
        .forEach((o) => o.classList.toggle("picked", o === b));
    }));

  modal.classList.remove("hidden");
  $("#scheduleTitle").focus();
}

function wireSchedules() {
  const modal = $("#scheduleModal");
  const close = () => modal.classList.add("hidden");
  $("#scheduleCancel").addEventListener("click", close);
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });

  $("#scheduleForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("#scheduleError");
    err.classList.add("hidden");
    $("#scheduleSubmit").disabled = true;
    try {
      const body = Object.fromEntries(new FormData(e.target).entries());
      body.intervalDays = Number(body.intervalDays);
      body.startNow = body.startNow === "true";
      if (!body.vendorId) delete body.vendorId;
      const res = await api("/api/schedules", { method: "POST", body });
      state.schedules = res.schedules;
      close();
      renderScheduleList();
      renderScheduleDetail();
      loadProperty();
    } catch (ex) {
      err.textContent = ex.message;
      err.classList.remove("hidden");
    } finally {
      $("#scheduleSubmit").disabled = false;
    }
  });
}

/* ---------------------------------------------------------- response times */

const SLA_LABEL = {
  emergency: "within 24 hours",
  major: "within 72 hours",
  standard: "within 10 days",
};

/**
 * How long is left, in words. Returns null for anything closed or undated, so
 * callers can leave the badge off entirely rather than print something empty.
 */
function dueState(ticket) {
  if (!ticket.due_at || ticket.status === "closed") return null;
  const due = new Date(String(ticket.due_at).replace(" ", "T") + "Z");
  const mins = Math.round((due.getTime() - Date.now()) / 60000);
  const span = (m) => {
    const abs = Math.abs(m);
    if (abs < 60) return `${abs}m`;
    if (abs < 60 * 24) return `${Math.round(abs / 60)}h`;
    return `${Math.round(abs / 1440)}d`;
  };
  if (mins < 0) return { level: "overdue", text: `${span(mins)} overdue` };
  // Inside a quarter of the shortest target, which is the point at which "due
  // tomorrow" stops being reassuring.
  if (mins <= 6 * 60) return { level: "soon", text: `due in ${span(mins)}` };
  return { level: "ok", text: `due in ${span(mins)}` };
}

function dueBadge(ticket) {
  const d = dueState(ticket);
  if (!d) return "";
  const target = ticket.sla_tier ? SLA_LABEL[ticket.sla_tier] : "";
  return `<span class="pill due-${d.level}"${
    target ? ` title="Target: ${esc(target)} of being raised"` : ""
  }>${esc(d.text)}</span>`;
}

/**
 * The response-time page — the same rules, readable by tenants, landlords and
 * vendors alike. Rendered from the server's own policy rather than written out
 * here, so the page cannot end up describing rules the app no longer follows.
 */
async function renderStandards() {
  const list = $("#standardsList");
  try {
    // Always refetched: the counts are live, and a page that quietly went stale
    // while open would be worse than one that says nothing.
    const { standards, tracking } = await api(`/api/standards?${scopeQuery()}`);
    list.innerHTML = standards.map((s) => {
      const open = tracking?.[s.tier] ?? [];
      const late = open.filter((t) => t.due_at && dueState(t)?.level === "overdue");
      return `
      <section class="standard standard-${esc(s.tier)}">
        <div class="standard-head">
          <div class="standard-when">${esc(s.label)}</div>
          ${tracking ? `<div class="standard-tally">${
            open.length
              ? `<b>${open.length}</b> open${
                  late.length ? `<span class="tally-late">${late.length} overdue</span>` : ""
                }`
              : "nothing open"
          }</div>` : ""}
        </div>
        <p class="standard-summary">${esc(s.summary)}</p>
        ${open.length ? `<ul class="standard-open">${open.map((t) => {
          const d = dueState(t);
          return `<li>
            <button class="standard-open-row" data-ticket="${t.id}">
              <span class="standard-open-title">${esc(t.title)}</span>
              <span class="standard-open-meta">
                ${d ? `<span class="pill due-${d.level}">${esc(d.text)}</span>` : ""}
                <span>${esc([t.unit, t.property_name].filter(Boolean).join(" · "))}</span>
              </span>
            </button></li>`;
        }).join("")}</ul>` : ""}
        <div class="standard-rule">What falls under this:</div>
        <ul class="standard-examples">${
          s.examples.map((e) => `<li>${esc(e)}</li>`).join("")
        }</ul>
      </section>`;
    }).join("");

    // The rows are a way in, not just a readout.
    list.querySelectorAll(".standard-open-row").forEach((b) =>
      b.addEventListener("click", async () => {
        showStandards(false);
        if (state.view !== "requests") setView("requests");
        await openTicket(Number(b.dataset.ticket)).catch(() => {});
      }));
  } catch {
    list.innerHTML = '<p class="error">The response times could not be loaded.</p>';
  }
}

function showStandards(show) {
  $("#standards").classList.toggle("hidden", !show);
  if (show) {
    renderStandards();
    // A real address, so the page can be linked to and survives a reload.
    if (location.hash !== "#response-times") location.hash = "response-times";
  } else if (location.hash === "#response-times") {
    history.replaceState(null, "", location.pathname + location.search);
  }
}

function wireStandards() {
  $("#standardsBtn").addEventListener("click", () => showStandards(true));
  $("#standardsBack").addEventListener("click", () => showStandards(false));
  addEventListener("hashchange", () => showStandards(location.hash === "#response-times"));
  if (location.hash === "#response-times") showStandards(true);
}

/* ------------------------------------------------------------------ photos */

const MAX_PHOTOS = 4;
/** Long edge, in pixels. A phone photo is several times this and shows no more. */
const PHOTO_MAX_EDGE = 1600;
const PHOTO_QUALITY = 0.82;

/** Photos staged in the composer or the new-request form, as data URLs. */
let pendingPhotos = [];

/**
 * Shrink a picked file to something worth sending.
 *
 * A modern phone photo is 3–8MB, and the server stores what it is given, so this
 * is what keeps the database from filling with pixels nobody looks at. It also
 * strips EXIF as a side effect of re-encoding — including where the photo was
 * taken, which is a tenant's home address.
 */
function shrinkPhoto(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, PHOTO_MAX_EDGE / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", PHOTO_QUALITY));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("That file could not be read as a photo."));
    };
    img.src = url;
  });
}

/** Take files from a picker into the staging list, and redraw the strip. */
async function stagePhotos(files, onDone) {
  const room = MAX_PHOTOS - pendingPhotos.length;
  if (room <= 0) {
    alert(`Up to ${MAX_PHOTOS} photos at a time.`);
    return;
  }
  for (const file of [...files].slice(0, room)) {
    if (!file.type.startsWith("image/")) continue;
    try {
      pendingPhotos.push(await shrinkPhoto(file));
    } catch (ex) {
      alert(ex.message);
    }
  }
  onDone();
}

/** The row of thumbnails sitting above whichever form is staging them. */
function renderPhotoStrip(el) {
  if (!el) return;
  el.classList.toggle("hidden", !pendingPhotos.length);
  el.innerHTML = pendingPhotos.map((src, i) => `
    <div class="shot-staged">
      <img src="${src}" alt="">
      <button type="button" class="shot-drop" data-i="${i}" title="Remove">×</button>
    </div>`).join("");
  el.querySelectorAll(".shot-drop").forEach((b) =>
    b.addEventListener("click", () => {
      pendingPhotos.splice(Number(b.dataset.i), 1);
      renderPhotoStrip(el);
    }));
}

/**
 * Fetched photos, by attachment id.
 *
 * The thread re-renders on every poll, so without this the same images would be
 * refetched every few seconds and flicker as they reloaded. Entries are object
 * URLs, or the in-flight promise so a re-render mid-fetch does not start a
 * second one. Bytes need the auth header, which an <img src> cannot send, so
 * they cannot simply be pointed at the URL.
 */
const photoCache = new Map();

function loadPhoto(id) {
  if (photoCache.has(id)) return photoCache.get(id);
  const pending = (async () => {
    const headers = authToken ? { authorization: `Bearer ${authToken}` } : {};
    const res = await fetch(`${API_BASE}/api/attachments/${id}`, {
      credentials: CROSS_ORIGIN ? "omit" : "same-origin",
      headers,
    });
    if (!res.ok) throw new Error("photo unavailable");
    const url = URL.createObjectURL(await res.blob());
    photoCache.set(id, url);
    return url;
  })();
  photoCache.set(id, pending);
  pending.catch(() => photoCache.delete(id));
  return pending;
}

/** Fill in any <img> the thread just drew that does not have its bytes yet. */
function hydratePhotos(root) {
  root.querySelectorAll("img.shot[data-photo]").forEach(async (img) => {
    if (img.dataset.loaded) return;
    try {
      const url = await loadPhoto(Number(img.dataset.photo));
      img.src = url;
      img.dataset.loaded = "1";
    } catch {
      img.closest(".shot-wrap")?.classList.add("shot-failed");
    }
  });
}

/** Photos on a thread message, as thumbnails that open full size. */
function renderPhotos(message) {
  // An optimistic echo carries the staged data URLs, which are already in hand.
  if (message.pendingPhotos?.length) {
    return `<div class="shots">${message.pendingPhotos
      .map((src) => `<span class="shot-wrap sending"><img class="shot" src="${src}" alt=""></span>`)
      .join("")}</div>`;
  }
  if (!message.photos?.length) return "";
  return `<div class="shots">${message.photos.map((p) => {
    const cached = photoCache.get(p.id);
    const src = typeof cached === "string" ? ` src="${cached}"` : "";
    return `<button type="button" class="shot-wrap" data-open="${p.id}">
      <img class="shot" data-photo="${p.id}"${src} alt="Photo on this request">
    </button>`;
  }).join("")}</div>`;
}

/** Full-size view. Escape or a click anywhere closes it. */
async function openPhoto(id) {
  const viewer = $("#photoViewer");
  const img = $("#photoViewerImg");
  img.removeAttribute("src");
  viewer.classList.remove("hidden");
  try {
    img.src = await loadPhoto(id);
  } catch {
    viewer.classList.add("hidden");
    alert("That photo could not be loaded.");
  }
}

function wirePhotoViewer() {
  const viewer = $("#photoViewer");
  const close = () => viewer.classList.add("hidden");
  viewer.addEventListener("click", close);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !viewer.classList.contains("hidden")) close();
  });
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
      const role = document.querySelector(".role input:checked")?.value || "tenant";
      $("#tenantFields").classList.toggle("hidden", role !== "tenant");
      $("#landlordFields").classList.toggle("hidden", role !== "landlord");
      $("#vendorFields").classList.toggle("hidden", role !== "vendor");
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
      if (body.vendorCode) body.vendorCode = body.vendorCode.toUpperCase();
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

  // A tenant has one property and no way to change it, so they get plain text
  // where the other two roles get the switcher. A vendor may have none at all
  // yet, in which case there is nothing to name.
  const oneProperty = me.role === "tenant";
  state.scope = oneProperty && me.property ? me.property.id : "all";
  $("#propName").classList.toggle("hidden", !oneProperty);
  $("#propSwitch").classList.toggle("hidden", oneProperty);
  $("#propName").textContent = me.property?.name ?? "";

  $("#whoami").textContent = me.role === "tenant"
    ? `${me.displayName} · Unit ${me.unit}`
    : `${me.displayName} · ${me.role}`;
  const badge = $("#botBadge");
  badge.textContent = (me.botEngine === "claude" ? "bot: claude" : "bot: built-in")
    + (me.qwin ? " + qwin" : "");
  badge.title = (me.botEngine === "claude"
    ? "Triage answered by Claude Opus 5"
    : "Triage answered by the built-in diagnostic script (set ANTHROPIC_API_KEY for Claude)")
    + (me.qwin ? ". Once the basics are in, the tenant talks to Qwin." : "");

  // Vendors do not open work, they pick it up — so there is nothing to add.
  $("#newBtn").classList.toggle("hidden", me.role === "vendor");
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
  if (!oneProperty) loadProperties();

  refresh();
  // Fetched even on the requests view, so the Messages badge is right on arrival.
  refreshChats().catch(() => {});
}

/* ------------------------------------------------------------- properties */

async function loadProperties() {
  try {
    const { properties } = await api("/api/properties");
    state.properties = properties;
    renderPropertySwitch();
  } catch {
    /* the switcher is a convenience — never block the app on it */
  }
}

function renderPropertySwitch() {
  const landlord = state.me.role === "landlord";
  // Everything at once is the default, and the first thing in the list — a
  // landlord's day starts with "what needs doing", not "which building".
  if (!state.properties.length) {
    // A vendor who has signed up but holds no code yet.
    $("#propSelect").innerHTML = "<option>No properties yet</option>";
    $("#propAdd").textContent = landlord ? "+ Property" : "+ Join";
    return;
  }
  const total = state.properties.reduce((n, p) => n + (p.open || 0), 0);
  const all = `<option value="all"${state.scope === "all" ? " selected" : ""}>All properties${
    total ? ` (${total})` : ""
  }</option>`;
  $("#propSelect").innerHTML = all + state.properties
    .map((p) => `<option value="${p.id}"${String(p.id) === String(state.scope) ? " selected" : ""}>${
      esc(p.name)
    }${p.open ? ` (${p.open})` : ""}</option>`)
    .join("");
  $("#propAdd").textContent = landlord ? "+ Property" : "+ Join";
  $("#propAdd").title = landlord
    ? "Add another property you manage"
    : "Join another property with a vendor code";
}

/**
 * Point the view at one property, or at all of them.
 *
 * "all" is a client-side scope: the server still keeps a cursor per account, so
 * picking a single property also moves that cursor — it is where a new to-do
 * lands when nothing else says otherwise.
 */
async function selectProperty(scope) {
  if (scope !== "all") {
    const { user } = await api(`/api/properties/${scope}/select`, { method: "POST" });
    state.me = user;
    $("#propName").textContent = user.property?.name ?? "";
  }
  state.scope = scope;
  state.selected = null;
  state.ticket = null;
  state.chatWith = null;
  state.chat = null;
  state.tenants = [];
  renderPropertySwitch();
  if (state.me.role === "landlord") loadProperty();
  renderDetail();
  await refresh(false);
  refreshChats().catch(() => {});
}

function wirePropertySwitch() {
  $("#propSelect").addEventListener("change", async (e) => {
    const chosen = e.target.value === "all" ? "all" : Number(e.target.value);
    try {
      await selectProperty(chosen);
    } catch (ex) {
      alert(ex.message);
      renderPropertySwitch(); // put the dropdown back where it was
    }
  });

  $("#propAdd").addEventListener("click", async () => {
    const landlord = state.me.role === "landlord";
    const answer = prompt(
      landlord
        ? "Name the new property (optional — leave blank and we'll name it for you):"
        : "Enter the vendor code for the property you're joining:",
      "",
    );
    if (answer === null) return; // cancelled
    if (!landlord && !answer.trim()) return;
    try {
      const { user, properties } = landlord
        ? await api("/api/properties", { method: "POST", body: { name: answer.trim() } })
        : await api("/api/properties/join", {
            method: "POST", body: { vendorCode: answer.trim().toUpperCase() },
          });
      if (user) state.me = user;
      state.properties = properties;
      // Nothing was on screen before the first property, so show it.
      if (!landlord && state.properties.length === 1) {
        state.scope = state.properties[0].id;
        renderPropertySwitch();
        await refresh(false);
        return;
      }
      // Land on everything rather than on the property just added — the point
      // of adding one is that the portfolio grew, and the new building is empty
      // so tunnelling into it would show a blank list.
      await selectProperty("all");
    } catch (ex) {
      alert(ex.message);
    }
  });
}

/** Landlord-only sidebar footer: workload at a glance, the join code, who's here. */
async function loadProperty() {
  try {
    const { tenants, vendors, counts, properties } = await api(`/api/property?${scopeQuery()}`);
    state.tenants = tenants;
    state.vendors = vendors ?? [];
    if (properties) state.properties = properties;
    const open = counts.open ?? 0;
    const done = counts.closed ?? 0;
    const everything = state.scope === "all";

    // Invite codes belong to one property, so across the portfolio the sidebar
    // shows the breakdown instead and the codes appear once a property is picked.
    // Each property carries its own pair of codes: the landlord hands these out,
    // so they belong next to the building they let you into rather than behind a
    // switch to it.
    // One code covers the whole portfolio, so it belongs above the per-property
    // ones rather than buried among them — it is the one usually handed out.
    const portfolio = state.me.portfolioCode
      ? `<div class="portfolio-code">
           <div class="portfolio-code-label">Vendors join everything you manage with:</div>
           ${codeChip("all properties", state.me.portfolioCode)}
         </div>`
      : "";

    const codes = everything
      ? `<div class="prop-breakdown">${
          (properties || []).map((p) => `
            <div class="prop-line">
              <button class="prop-line-open" data-id="${p.id}" title="Show only this property">
                <span class="prop-line-name">${esc(p.name)}</span>
                <span class="prop-line-meta">${p.open || 0} open · ${p.tenants || 0} tenant${
                  p.tenants === 1 ? "" : "s"
                }</span>
              </button>
              <div class="code-row">
                ${codeChip("tenants", p.join_code)}${codeChip("vendors", p.vendor_code)}
              </div>
            </div>`).join("") || "No properties yet."
        }</div>`
      : `<div class="code-row single">
           ${codeChip("tenants", state.me.property.joinCode)}
           ${codeChip("vendors", state.me.property.vendorCode)}
         </div>`;

    $("#landlordInfo").innerHTML = `
      <div class="counts">
        <span><b>${open}</b> open</span>
        <span><b>${done}</b> done</span>
        <span><b>${tenants.length}</b> tenant${tenants.length === 1 ? "" : "s"}</span>
      </div>
      ${portfolio}
      ${codes}
      <div style="margin-top:10px">${
        tenants.length
          ? tenants.map((t) => `${esc(t.display_name)} (${esc(t.unit || "—")})`).join(", ")
          : "No tenants have joined yet."
      }</div>
      <div style="margin-top:10px">${
        vendors && vendors.length
          ? vendors.map((v) =>
              `${esc(v.display_name)}${v.jobs ? ` (${v.jobs} job${v.jobs === 1 ? "" : "s"})` : ""}`
            ).join(", ")
          : "No vendors yet — share a code above with a contractor."
      }</div>`;

    // The breakdown doubles as a way in: clicking a building narrows to it.
    $("#landlordInfo").querySelectorAll(".prop-line-open").forEach((b) =>
      b.addEventListener("click", () => selectProperty(Number(b.dataset.id)).catch(() => {})));
    wireCodeChips($("#landlordInfo"));
  } catch {
    /* sidebar extras are optional — never block the list on them */
  }
}

/**
 * An invite code, as one click-to-copy control.
 *
 * These get read aloud, texted, and typed in by hand, so the whole chip is the
 * copy target rather than a separate little button beside it.
 */
function codeChip(who, code) {
  if (!code) return "";
  return `<button type="button" class="code-chip" data-code="${esc(code)}"
    title="Copy the ${who} code">
      <span class="code-chip-who">${who}</span>
      <span class="code">${esc(code)}</span>
      <span class="code-chip-state" aria-hidden="true"></span>
    </button>`;
}

/**
 * Copy, with a fallback: navigator.clipboard needs a secure context, which the
 * page has over https and on localhost but not if it is opened over plain http
 * on a LAN address.
 */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.cssText = "position:fixed;top:-1000px;opacity:0";
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    area.remove();
    return ok;
  }
}

function wireCodeChips(root) {
  root.querySelectorAll(".code-chip").forEach((chip) => {
    chip.addEventListener("click", async (e) => {
      e.stopPropagation(); // the row behind this one narrows the view
      const ok = await copyText(chip.dataset.code);
      chip.classList.toggle("copied", ok);
      chip.classList.toggle("copy-failed", !ok);
      const state = chip.querySelector(".code-chip-state");
      state.textContent = ok ? "copied" : "press ⌘C";
      if (!ok) {
        // Nothing was copied, so at least leave it selected to copy by hand.
        const range = document.createRange();
        range.selectNodeContents(chip.querySelector(".code"));
        getSelection().removeAllRanges();
        getSelection().addRange(range);
      }
      clearTimeout(chip._reset);
      chip._reset = setTimeout(() => {
        chip.classList.remove("copied", "copy-failed");
        state.textContent = "";
      }, 1600);
    });
  });
}

/* --------------------------------------------------------------- messaging */

const REQUESTS_LABEL = { tenant: "Requests", landlord: "To-dos", vendor: "Jobs" };
const CADENCE_LABEL = (days) => ({
  7: "weekly", 14: "every 2 weeks", 30: "monthly", 90: "quarterly",
  182: "twice a year", 365: "yearly",
}[days] ?? `every ${days} days`);

function renderViews() {
  const unread = state.chats.reduce((n, c) => n + (c.unread || 0), 0);
  const tabs = [["requests", REQUESTS_LABEL[state.me.role] || "Requests", 0]];
  // Recurring upkeep is the landlord's to set up; everyone else just sees the
  // to-dos it raises.
  if (state.me.role === "landlord") tabs.push(["schedules", "Recurring", 0]);
  // Messaging is a tenant<->landlord channel; a vendor talks on the job itself.
  if (state.me.role !== "vendor") tabs.push(["messages", "Messages", unread]);
  $("#views").innerHTML = tabs
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
  $("#newBtn").classList.toggle("hidden",
    state.me.role === "vendor" || view === "messages");
  $("#newBtn").textContent = view === "schedules" ? "+ New recurring"
    : state.me.role === "tenant" ? "+ New request" : "+ New to-do";
  renderViews();
  if (requests) {
    state.chatWith = null;
    refresh(false);
    renderDetail();
  } else if (view === "schedules") {
    state.selected = null;
    state.ticket = null;
    state.chatWith = null;
    loadSchedules();
  } else {
    state.selected = null;
    state.ticket = null;
    refreshChats();
  }
}

async function refreshChats() {
  const { chats } = await api(`/api/chats?${scopeQuery()}`);
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
      <div class="with-avatar">
        ${avatar(c.name)}
        <div>
          <div class="chat-row-top">
            <span class="chat-name">${esc(c.name)}</span>
            <span class="row-marks">${
              c.unread ? `<span class="unread">${c.unread}</span>` : ""
            }<span class="row-meta">${c.last_at ? when(c.last_at) : ""}</span></span>
          </div>
          <div class="chat-sub">${esc(
            [c.subtitle, state.scope === "all" ? c.property_name : null].filter(Boolean).join(" · ")
          )}</div>
          <div class="row-snippet ${c.last_message ? "" : "chat-empty"}">${
            c.last_message ? esc(c.last_message) : "No messages yet"
          }</div>
        </div>
      </div>
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
      <div class="with-avatar">
        ${avatar(state.chat.name)}
        <div>
          <h2>${esc(state.chat.name)}</h2>
          <div class="detail-meta"><span>${esc(state.chat.subtitle || "")}</span></div>
        </div>
      </div>
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
    : state.me.role === "vendor"
      ? [["open", "Open jobs"], ["mine", "Mine"], ["closed", "Done"]]
      : [["open", "To-do"], ["closed", "Done"], ["all", "All"]];
  $("#filters").innerHTML = opts
    .map(([v, l]) => `<button data-f="${v}" class="${state.filter === v ? "active" : ""}">${l}</button>`)
    .join("");
  $("#filters").querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => { state.filter = b.dataset.f; renderFilters(); refresh(); }));
}

async function refresh(keepSelection = true) {
  // "Mine" is not a status — it is every job this vendor has picked up.
  const query = state.filter === "mine" ? "status=all&assigned=me" : `status=${state.filter}`;
  const { tickets } = await api(`/api/tickets?${query}&${scopeQuery()}`);
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
        : state.me.role === "vendor"
          ? (!state.properties.length
              ? "You're not on any properties yet.<br>Tap <b>+ Join</b> and enter the vendor code a landlord sent you."
              : state.filter === "mine"
                ? "You haven't picked up any jobs here.<br>Check <b>Open jobs</b> for work going spare."
                : "No open jobs here right now.")
          : "Nothing on the list.<br>Tenant requests land here once the assistant escalates them."
    }</div>`;
    return;
  }
  list.innerHTML = state.tickets.map((t) => {
    const statusPill = t.status === "open"
      ? `<span class="pill open">to-do</span>`
      : t.status === "triage"
        ? `<span class="pill triage">${t.handler === "qwin" ? "with Qwin" : "with bot"}</span>`
      : `<span class="pill closed">closed</span>`;
    const who = state.me.role !== "tenant" && t.tenant_name
      ? `${esc(t.tenant_name)}${t.tenant_unit ? " · " + esc(t.tenant_unit) : ""}`
      : CATEGORY_LABEL[t.category] || "Other";
    // Vendors are choosing what to pick up, so who already has a job is the
    // single most useful thing on the row.
    // Only worth saying when more than one building is in view; inside a single
    // property it would be the same word on every row.
    const where = state.scope === "all" && t.property_name
      ? `<span class="pill where">${esc(t.property_name)}</span>` : "";
    // Worth saying on the row: this arrived on its own, nobody reported it.
    const repeats = t.recurring_days
      ? `<span class="pill recurring">${esc(CADENCE_LABEL(t.recurring_days))}</span>` : "";
    const claim = state.me.role === "vendor" && t.assigned_vendor_id
      ? `<span class="pill ${t.assigned_vendor_id === state.me.id ? "mine-job" : "taken"}">${
          t.assigned_vendor_id === state.me.id ? "yours" : esc(t.vendor_name || "taken")
        }</span>`
      : "";
    // A tenant's own request vs one their landlord raised with them.
    const fromLandlord = state.me.role === "tenant" && t.creator_role === "landlord";
    const unread = t.unread > 0
      ? `<span class="unread" title="${t.unread} new message${t.unread === 1 ? "" : "s"}">${t.unread}</span>`
      : "";
    return `<div class="row ${state.selected === t.id ? "active" : ""} ${t.unread > 0 ? "has-unread" : ""}" data-id="${t.id}">
      <div class="row-top"><span class="row-title">${esc(t.title)}</span>
        <span class="row-marks">${unread}<span class="dot p-${t.priority}" title="priority: ${t.priority}"></span></span></div>
      <div class="row-meta">${statusPill}${dueBadge(t)}${repeats}${where}${claim}${
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
  // Photos staged against one request must not follow you into another.
  if (switching) pendingPhotos = [];
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
        : state.me.role === "vendor"
          ? "Pick a job to see what the tenant reported, then claim it if you'll take it on."
          : "Pick an item to see the full history — including the tenant's conversation with the assistant."}</p>
    </div></div>`;
    return;
  }
  const t = state.ticket;
  const isTenant = state.me.role === "tenant";
  const isVendor = state.me.role === "vendor";
  const closed = t.status === "closed";
  const mineToWork = isVendor && t.assigned_vendor_id === state.me.id;

  const actions = [];
  if (t.status === "triage" && isTenant) {
    actions.push(`<button class="ghost" id="escalateBtn">Send to landlord now</button>`);
  }
  if (isVendor && !closed) {
    if (mineToWork) {
      actions.push(`<button class="ghost" id="releaseBtn">Release</button>`);
    } else if (!t.assigned_vendor_id) {
      actions.push(`<button class="primary small" id="claimBtn">Pick this up</button>`);
    }
  }
  // A vendor closes work they took on; anyone else closes their own item.
  if (!closed && (!isVendor || mineToWork)) {
    actions.push(`<button class="primary small" id="closeBtn">${
      isTenant ? "Mark as resolved" : "Mark complete"}</button>`);
  }
  if (closed) actions.push(`<button class="ghost" id="reopenBtn">Reopen</button>`);

  // Handing work to a vendor sits with the other things only a landlord decides
  // about a task, and reads as one line: who is on this.
  const isLandlord = state.me.role === "landlord";
  const assignRow = isLandlord && !closed
    ? `<label class="inline-edit">vendor
         <select id="assignSelect">
           <option value="">Nobody yet</option>
           ${state.vendors.map((v) =>
             `<option value="${v.id}"${
               v.id === t.assigned_vendor_id ? " selected" : ""
             }>${esc(v.display_name)}</option>`).join("")}
         </select>
       </label>${
         state.vendors.length ? "" :
         '<span class="sla-note">no vendors yet — share a code from the sidebar</span>'
       }`
    : "";

  // The landlord owns the list, so they can re-file a task inline. The bot's
  // guess at priority and category is a starting point, not the final word — but
  // it is not a vendor's call either.
  const canEdit = state.me.role === "landlord" && !closed;
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
          : t.status === "triage"
            ? `<span class="pill triage">${t.handler === "qwin" ? "with Qwin" : "with the assistant"}</span>`
          : '<span class="pill closed">closed</span>'}
        ${meta}
        ${assignRow}
        ${party}
        ${t.recurring_title
          ? `<span class="pill recurring" title="Raised by a recurring schedule">${
              esc(CADENCE_LABEL(t.recurring_days))}</span>`
          : ""}
        ${dueBadge(t)}
        ${t.sla_tier && t.status !== "closed"
          ? `<span class="sla-note">target: ${esc(SLA_LABEL[t.sla_tier])} of being raised</span>`
          : ""}
        ${state.scope === "all" && t.property_name
          ? `<span class="pill where">${esc(t.property_name)}</span>` : ""}
        ${t.assigned_vendor_id
          ? `<span class="pill ${mineToWork ? "mine-job" : "taken"}">${
              mineToWork ? "yours" : esc(t.vendor_name || "vendor")
            }</span>`
          : ""}
        <span>opened ${when(t.created_at)}</span>
      </div>
      ${renderBasics(t)}
      ${brief}
      <div class="detail-actions">${actions.join("")}</div>
    </div>
    ${closed && t.resolution ? `<div class="resolution" style="margin-top:14px"><b>Resolved:</b> ${esc(t.resolution)}</div>` : ""}
    <div class="thread" id="thread">${renderThread()}
      ${state.busy ? `<div class="msg bot"><div class="bubble thinking">${
        t.handler === "qwin" ? "Qwin" : "The assistant"} is thinking…</div></div>` : ""}
    </div>
    ${closed ? "" : `
    <div class="photo-strip hidden" id="photoStrip"></div>
    <div class="composer">
      <input type="file" id="photoInput" accept="image/*" multiple hidden>
      <button class="ghost photo-btn" id="photoBtn" title="Add a photo" aria-label="Add a photo">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
                stroke-linejoin="round"
                d="M3 7.5h3l1.5-2h9l1.5 2h3v11H3zM12 16a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z"/>
        </svg>
      </button>
      <textarea id="composerInput" rows="1" placeholder="${
        t.status === "triage" && isTenant
          ? (t.handler === "qwin" ? "Answer Qwin…" : "Answer the assistant…")
          : "Write a message…"}"></textarea>
      <button class="primary" id="sendBtn">Send</button>
    </div>`}`;

  renderPhotoStrip($("#photoStrip"));
  hydratePhotos(el);
  // Tap a thumbnail to see it properly — a leak under a sink is not legible at
  // thumbnail size, which is the whole reason for sending it.
  el.querySelectorAll(".shot-wrap").forEach((b) =>
    b.addEventListener("click", () => openPhoto(Number(b.dataset.open))));
  $("#photoBtn")?.addEventListener("click", () => $("#photoInput").click());
  $("#photoInput")?.addEventListener("change", async (e) => {
    await stagePhotos(e.target.files, () => renderPhotoStrip($("#photoStrip")));
    e.target.value = ""; // so picking the same file twice still fires
  });

  $("#closeBtn")?.addEventListener("click", onClose);
  $("#claimBtn")?.addEventListener("click", () => act(`/api/tickets/${t.id}/claim`));
  $("#releaseBtn")?.addEventListener("click", () => act(`/api/tickets/${t.id}/release`));
  $("#reopenBtn")?.addEventListener("click", () => act(`/api/tickets/${t.id}/reopen`));
  $("#escalateBtn")?.addEventListener("click", () => act(`/api/tickets/${t.id}/escalate`));
  $("#prioritySelect")?.addEventListener("change", (e) =>
    act(`/api/tickets/${t.id}/update`, { priority: e.target.value }));
  $("#categorySelect")?.addEventListener("change", (e) =>
    act(`/api/tickets/${t.id}/update`, { category: e.target.value }));
  $("#assignSelect")?.addEventListener("change", (e) =>
    act(`/api/tickets/${t.id}/assign`, { vendorId: e.target.value || null }));

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
  const ROLE_FALLBACK = { tenant: "Tenant", landlord: "Landlord", vendor: "Vendor" };
  const label = m.author === "bot" ? "Maintenance assistant"
    : m.author === "qwin" ? "Qwin"
    : m.author === "system" ? ""
    : m.author_name || ROLE_FALLBACK[m.author] || "";
  // My own messages sit on the right; the other party's on the left.
  const mine = m.author === state.me.role;
  const cls = m.author === "system" ? "system"
    : m.author === "bot" || m.author === "qwin" ? "bot"
    : mine ? m.author : `${m.author} mine-left`;
  return `<div class="msg ${cls}">
    ${label ? `<div class="who-line">${esc(label)}</div>` : ""}
    ${m.body ? `<div class="bubble">${esc(m.body)}</div>` : ""}
    ${renderPhotos(m)}
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
  const photos = pendingPhotos;
  // A photo on its own is a complete message.
  if ((!body && !photos.length) || state.busy) return;
  input.value = "";
  input.style.height = "auto";
  pendingPhotos = [];

  // Optimistic echo so the thread feels immediate while the bot thinks. The
  // staged data URLs stand in for the attachments until the server answers.
  state.messages.push({
    author: state.me.role, author_name: state.me.displayName, body,
    pendingPhotos: photos,
  });
  const waitingOnBot = state.ticket.status === "triage" && state.me.role === "tenant";
  state.busy = waitingOnBot;
  renderDetail(false);

  try {
    const res = await api(`/api/tickets/${state.ticket.id}/messages`, {
      method: "POST", body: { body, photos },
    });
    state.ticket = res.ticket;
    state.messages = res.messages;
  } catch (ex) {
    alert(ex.message);
    // Hand the message back rather than losing it, photos included.
    input.value = body;
    pendingPhotos = photos;
    state.messages = state.messages.filter((m) => m.pendingPhotos !== photos);
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
    // A tenant's request goes through the decision tree, not the blank form.
    if (tenant) { openIntake(); return; }
    $("#modalTitle").textContent = tenant ? "New maintenance request" : "New to-do";
    $("#modalSubmit").textContent = tenant ? "Start with the assistant" : "Add to list";
    $("#descLabel").textContent = tenant ? "What's happening?" : "Details (optional)";
    $("#modalHint").textContent = tenant
      ? "The assistant will ask a couple of questions first — plenty of things turn out to have a two-minute fix. If not, it goes straight to your landlord."
      : "This goes on your to-do list. Tenant requests arrive here automatically once triaged.";
    document.querySelectorAll(".landlord-field").forEach((f) => f.classList.toggle("hidden", tenant));
    if (!tenant) {
      $("#newCategory").innerHTML = options(CATEGORY_LABEL, "other");
      // Looking at one building, the to-do belongs to it and there is nothing to
      // ask. Looking at all of them, it has to be told which — defaulting to the
      // one last opened rather than to whichever sorts first.
      const several = state.scope === "all" && state.properties.length > 1;
      $("#newPropertyField").classList.toggle("hidden", !several);
      $("#newProperty").innerHTML = state.properties
        .map((p) => `<option value="${p.id}"${
          p.id === state.me.property.id ? " selected" : ""
        }>${esc(p.name)}</option>`).join("");
      if (!several) $("#newProperty").value = String(state.me.property.id);
      fillTenantOptions();
    }
    $("#newDesc").required = tenant;
    pendingPhotos = [];
    renderPhotoStrip($("#newPhotoStrip"));
    $("#modalError").classList.add("hidden");
    modal.classList.remove("hidden");
    $("#newTitle").focus();
  };
  // A to-do can only be raised with a tenant who actually lives at the property
  // it is for, so this list follows the property picker.
  function fillTenantOptions() {
    const forProperty = Number($("#newProperty").value || state.me.property.id);
    $("#newTenant").innerHTML =
      '<option value="">Just me — internal to-do</option>' +
      state.tenants
        .filter((t) => t.property_id === undefined || t.property_id === forProperty)
        .map((t) =>
          `<option value="${t.id}">${esc(t.display_name)}${t.unit ? " · " + esc(t.unit) : ""}</option>`
        ).join("");
  }
  $("#newProperty").addEventListener("change", fillTenantOptions);

  $("#newPhotoBtn").addEventListener("click", () => $("#newPhotoInput").click());
  $("#newPhotoInput").addEventListener("change", async (e) => {
    await stagePhotos(e.target.files, () => renderPhotoStrip($("#newPhotoStrip")));
    e.target.value = "";
  });

  $("#newBtn").addEventListener("click", () =>
    state.view === "schedules" ? openScheduleModal() : open());
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
      body.photos = pendingPhotos;
      const { ticket } = await api("/api/tickets", { method: "POST", body });
      e.target.reset();
      pendingPhotos = [];
      renderPhotoStrip($("#newPhotoStrip"));
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

/* ------------------------------------------------------- request intake */

/**
 * A tenant's new request is a short decision tree: category, then the issue,
 * then the four basics every diagnosis needs — what is broken, where, when it
 * started, anything else. Only then does the assistant get involved, and it
 * asks for whichever of the four the form left open before it decides anything.
 *
 * Every step can be gone back to: the Back button, the finished segments of the
 * progress strip, and the chips listing what has been chosen so far.
 */
const INTAKE_STEPS = ["Category", "Issue", "Details", "Assistant"];
const blankBasics = () => ({ what: "", room: "", spot: "", when: "", trigger: "", notes: "" });
const intake = { step: 1, group: null, issue: null, d: blankBasics() };

async function loadIntakeTree() {
  if (state.intakeTree) return state.intakeTree;
  state.intakeTree = await api("/api/intake");
  return state.intakeTree;
}

async function openIntake() {
  const modal = $("#intakeModal");
  intake.step = 1;
  intake.group = null;
  intake.issue = null;
  intake.d = blankBasics();
  pendingPhotos = [];
  modal.classList.remove("hidden");
  $("#intakeBody").innerHTML = '<p class="intake-lede">Loading…</p>';
  try {
    await loadIntakeTree();
  } catch (ex) {
    $("#intakeBody").innerHTML = `<p class="error">${esc(ex.message)}</p>`;
    return;
  }
  renderIntake();
}

function closeIntake() {
  $("#intakeModal").classList.add("hidden");
  pendingPhotos = [];
}

/** Go back to an earlier step. Everything chosen after it is cleared. */
function intakeGoTo(n) {
  if (n <= 2) intake.issue = null;
  if (n <= 1) intake.group = null;
  intake.step = n;
  renderIntake();
}

function renderIntake() {
  const steps = $("#intakeSteps");
  steps.innerHTML = INTAKE_STEPS.map((label, i) => {
    const n = i + 1;
    const cls = n < intake.step ? "done" : n === intake.step ? "current" : "";
    const attrs = n < intake.step
      ? ` data-go="${n}" title="Back to ${esc(label)}"`
      : ` disabled${n === intake.step ? ' aria-current="step"' : ""}`;
    return `<button type="button" class="${cls}"${attrs}>
      <span class="bar"></span><span class="lbl">${n} ${esc(label)}</span></button>`;
  }).join("");
  steps.querySelectorAll("[data-go]").forEach((b) =>
    b.addEventListener("click", () => intakeGoTo(Number(b.dataset.go))));

  const crumbs = $("#intakeCrumbs");
  const parts = [];
  if (intake.group) {
    parts.push(`<button type="button" class="crumb" data-go="1" title="Change category">${
      esc(intake.group.name)} <span class="x">✕</span></button>`);
  }
  if (intake.issue) {
    parts.push('<span class="sep">›</span>');
    parts.push(`<button type="button" class="crumb" data-go="2" title="Change issue">${
      esc(intake.issue.name)} <span class="x">✕</span></button>`);
  }
  crumbs.innerHTML = parts.join("") ||
    '<span class="hint">Your choices will appear here. Tap one to change it.</span>';
  crumbs.querySelectorAll("[data-go]").forEach((b) =>
    b.addEventListener("click", () => intakeGoTo(Number(b.dataset.go))));

  if (intake.step === 1) renderIntakeCategory();
  else if (intake.step === 2) renderIntakeIssue();
  else renderIntakeDetails();
}

function renderIntakeCategory() {
  const body = $("#intakeBody");
  body.innerHTML = `
    <p class="intake-lede">What kind of problem is it? Pick the closest match — you can change it later.</p>
    <div class="intake-grid">${state.intakeTree.groups.map((g) => `
      <button type="button" class="intake-tile" data-group="${esc(g.id)}">
        <span class="name">${esc(g.name)}</span><span class="eg">${esc(g.eg)}</span>
      </button>`).join("")}
    </div>
    <div class="intake-actions"><span></span>
      <button type="button" class="ghost" id="intakeCancel">Cancel</button></div>`;
  body.querySelectorAll("[data-group]").forEach((b) =>
    b.addEventListener("click", () => {
      intake.group = state.intakeTree.groups.find((g) => g.id === b.dataset.group);
      intake.step = 2;
      renderIntake();
    }));
  $("#intakeCancel").addEventListener("click", closeIntake);
}

function renderIntakeIssue() {
  const body = $("#intakeBody");
  const g = intake.group;
  body.innerHTML = `
    <p class="intake-lede">${esc(g.name)}: what's happening?</p>
    <div class="intake-list">${g.issues.map((i) => `
      <button type="button" class="intake-row ${i.urgent ? "urgent" : ""}" data-issue="${esc(i.id)}">
        <span><span class="name">${esc(i.name)}</span><br><span class="eg">${esc(i.eg)}</span></span>
        ${i.urgent ? '<span class="pill urgent">emergency</span>' : '<span class="chev">›</span>'}
      </button>`).join("")}
    </div>
    <div class="intake-actions">
      <button type="button" class="ghost back" data-go="1">Back</button>
      <button type="button" class="ghost" id="intakeCancel">Cancel</button>
    </div>`;
  body.querySelectorAll("[data-issue]").forEach((b) =>
    b.addEventListener("click", () => {
      intake.issue = g.issues.find((i) => i.id === b.dataset.issue);
      intake.step = 3;
      renderIntake();
    }));
  body.querySelector("[data-go]").addEventListener("click", () => intakeGoTo(1));
  $("#intakeCancel").addEventListener("click", closeIntake);
}

/** A "what" placeholder that matches the category, so the tenant names the fixture, not the symptom. */
const WHAT_PLACEHOLDER = {
  plumbing: "e.g. kitchen faucet, toilet, shower drain, water heater",
  electrical: "e.g. bathroom outlet, bedroom ceiling light, the breaker labelled KITCHEN",
  hvac: "e.g. living room radiator, wall thermostat, bedroom vent",
  appliance: "e.g. dishwasher, back-left stove burner, dryer",
  doors: "e.g. front door deadbolt, bedroom window, patio screen",
  pests: "e.g. mice under the sink, ants along the counter, wasp nest on the balcony",
  structure: "e.g. bathroom ceiling, bedroom wall by the closet, kitchen floor tile",
  other: "e.g. hallway smoke detector, lobby door, mailbox",
};

const basicsComplete = (d) => d.what.trim().length >= 2 && d.room.length > 0;

function renderIntakeDetails() {
  const body = $("#intakeBody");
  const { issue, d } = intake;
  const tree = state.intakeTree;
  const chips = (list, picked, attr) => list.map((v) =>
    `<button type="button" class="${picked === v ? "on" : ""}" data-${attr}="${esc(v)}">${esc(v)}</button>`,
  ).join("");

  body.innerHTML = `
    ${issue.emergency ? `<div class="intake-emergency" role="alert">
      <b>${esc(issue.emergency.title)}</b>
      <ol>${issue.emergency.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
    </div>` : ""}
    <p class="intake-lede">Four quick things before the assistant works out what to do. Short answers are fine.</p>
    <div class="intake-form">
      <div class="intake-field">
        <div class="lab"><span>What is broken <span class="req">*</span></span></div>
        <input type="text" id="inWhat" value="${esc(d.what)}" maxlength="120"
          placeholder="${esc(WHAT_PLACEHOLDER[intake.group.id] || "Name the thing that's broken")}">
      </div>
      <div class="intake-field">
        <div class="lab"><span>Where <span class="req">*</span></span></div>
        <div class="chips" id="inRooms">${chips(tree.rooms, d.room, "room")}</div>
        <input type="text" id="inSpot" value="${esc(d.spot)}" maxlength="160"
          placeholder="Exact spot, e.g. under the sink, back-left burner, ceiling by the window">
      </div>
      <div class="intake-field">
        <div class="lab"><span>When did it start</span>
          <span class="opt">${issue.whenMatters ? "helps with this one" : "if relevant"}</span></div>
        <div class="chips" id="inWhens">${chips(tree.whens, d.when, "when")}</div>
        <input type="text" id="inTrigger" value="${esc(d.trigger)}" maxlength="200"
          placeholder="Happens when… e.g. only when the shower runs, every time the dryer starts">
      </div>
      <div class="intake-field">
        <div class="lab"><span>Anything else</span><span class="opt">optional</span></div>
        <textarea id="inNotes" rows="3" maxlength="2000"
          placeholder="What you've already tried, whether it's getting worse, damage to your things, best times for a visit">${esc(d.notes)}</textarea>
      </div>
      <div class="intake-field">
        <div class="lab"><span>Photos</span><span class="opt">optional</span></div>
        <input type="file" id="intakePhotoInput" accept="image/*" multiple hidden>
        <button type="button" class="ghost block-soft" id="intakePhotoBtn">Add a photo</button>
        <div class="photo-strip hidden" id="intakePhotoStrip"></div>
      </div>
    </div>
    <p id="intakeError" class="error hidden" style="margin-top:12px"></p>
    <div class="intake-actions">
      <button type="button" class="ghost back" data-go="2">Back</button>
      <span class="right">
        <button type="button" class="ghost" id="intakeCancel">Cancel</button>
        <button type="button" class="primary" id="intakeSubmit" disabled>${
          issue.urgent ? "Send as emergency" : "Continue with the assistant"}</button>
      </span>
    </div>`;

  const submit = $("#intakeSubmit");
  const sync = () => {
    d.what = $("#inWhat").value;
    d.spot = $("#inSpot").value;
    d.trigger = $("#inTrigger").value;
    d.notes = $("#inNotes").value;
    submit.disabled = !basicsComplete(d);
  };
  ["inWhat", "inSpot", "inTrigger", "inNotes"].forEach((id) =>
    $(`#${id}`).addEventListener("input", sync));
  // One-tap chips; tapping the picked one clears it.
  const wireChips = (holder, attr, key) => {
    holder.addEventListener("click", (e) => {
      const b = e.target.closest(`[data-${attr}]`);
      if (!b) return;
      const v = b.dataset[attr];
      d[key] = d[key] === v ? "" : v;
      holder.querySelectorAll("button").forEach((c) => c.classList.toggle("on", c.dataset[attr] === d[key]));
      sync();
    });
  };
  wireChips($("#inRooms"), "room", "room");
  wireChips($("#inWhens"), "when", "when");

  $("#intakePhotoBtn").addEventListener("click", () => $("#intakePhotoInput").click());
  $("#intakePhotoInput").addEventListener("change", async (e) => {
    await stagePhotos(e.target.files, () => renderPhotoStrip($("#intakePhotoStrip")));
    e.target.value = "";
  });
  renderPhotoStrip($("#intakePhotoStrip"));

  body.querySelector("[data-go]").addEventListener("click", () => intakeGoTo(2));
  $("#intakeCancel").addEventListener("click", closeIntake);
  submit.addEventListener("click", submitIntake);
  sync();
  $("#inWhat").focus();
}

async function submitIntake() {
  const btn = $("#intakeSubmit");
  const err = $("#intakeError");
  if (!basicsComplete(intake.d)) return;
  btn.disabled = true;
  btn.textContent = intake.issue.urgent ? "Sending…" : "Asking the assistant…";
  err.classList.add("hidden");
  try {
    const { ticket } = await api("/api/tickets", {
      method: "POST",
      body: { intake: { issue: intake.issue.id, ...intake.d }, photos: pendingPhotos },
    });
    closeIntake();
    await refresh(false);
    await openTicket(ticket.id);
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.remove("hidden");
    btn.disabled = false;
    btn.textContent = intake.issue.urgent ? "Send as emergency" : "Continue with the assistant";
  }
}

function wireIntake() {
  const modal = $("#intakeModal");
  modal.addEventListener("click", (e) => { if (e.target === modal) closeIntake(); });
}

/**
 * The basics a request was raised with, as fields on the thread head. Read
 * from the ticket's stored intake; the issue name comes from the tree, which
 * is fetched lazily for whoever is looking.
 */
function renderBasics(t) {
  if (!t.intake) return "";
  let d;
  try { d = JSON.parse(t.intake); } catch { return ""; }
  if (!d || typeof d !== "object") return "";
  if (!state.intakeTree) loadIntakeTree().then(() => renderDetail(false)).catch(() => {});
  const issue = state.intakeTree?.groups.flatMap((g) => g.issues).find((i) => i.id === d.issue);
  const where = [d.room, d.spot].filter(Boolean).join(", ");
  const when = [d.when, d.trigger && `happens ${d.trigger}`].filter(Boolean).join(". ");
  const rows = [
    ["Issue", issue?.name], ["What", d.what], ["Where", where], ["When", when], ["Other", d.notes],
  ].filter(([, v]) => v);
  return `<div class="basics">${rows.map(([k, v]) =>
    `<div><div class="k">${k}</div><div class="v">${esc(v)}</div></div>`).join("")}</div>`;
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
wireIntake();
wireAccount();
wirePropertySwitch();
wirePhotoViewer();
wireStandards();
wireSchedules();
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
